# Release runbook

`@uxfront/uxd` is published by `.github/workflows/changesets.yml`, which runs on
every push to `main`. Releases are driven by [Changesets](https://github.com/changesets/changesets);
`.changeset/README.md` covers the day-to-day author workflow.

**Nobody cuts a tag, and nobody runs `npm publish`.** `changeset version` writes
the version commit, and `changeset publish` pushes the git tag and creates the
GitHub release. A hand-pushed tag releases nothing.

| Step | Who |
|---|---|
| Add a changeset to a feature PR | The PR author |
| Merge the feature PR | The repository owner |
| Open the "Version Packages" PR | The `Changesets` workflow |
| **Merge the "Version Packages" PR — this publishes** | **The repository owner** |
| Publish, tag, GitHub release | The `Changesets` workflow |
| Call the release good, or roll it back | The repository owner |

## How a release happens

The workflow runs on every push to `main` and takes one of two paths, decided
entirely by whether `.changeset/` holds any changesets.

1. **Changesets pending → version.** The workflow opens or updates a
   **"Version Packages"** PR that consumes them, bumps `version` in
   `package.json` and writes `CHANGELOG.md`. Nothing is published.
2. **No changesets pending → publish.** The workflow publishes `@uxfront/uxd`
   if that version is absent from the registry, then pushes the git tag and
   creates the GitHub release.

> [!WARNING]
> **Merging the "Version Packages" PR is the publish.** It empties
> `.changeset/`, which sends the next run down the publish path. There is no
> second confirmation and no approval step after it. Treat that merge as the
> deploy button.

## What gates the publish

The job fails, and nothing reaches npm, if any of these fail.

1. **`pnpm install --frozen-lockfile`** — the lockfile must match
   `package.json`.
2. **`pnpm run typecheck`**.
3. **`pnpm test`** — the full suite, including the packaging guard.
4. **`pnpm run guard:packaging`** — run again by the `release` script as the
   last thing before `changeset publish`. It rebuilds, runs the *built*
   entrypoint, and asserts that every promised verb resolves as a verb rather
   than as a project name, and that `dist/src/commands/setup.js` exists. This is
   the gate the `1.0.0` defect would have tripped. It lives in the `release`
   script on purpose, so editing the workflow cannot bypass it.

`uxd version` reads `version` from the package's own `package.json` at runtime,
so the published CLI reports whatever `changeset version` wrote. The two cannot
disagree.

### Credentials

Publishing uses **npm trusted publishing**. There is no npm token and no
`NODE_AUTH_TOKEN`. The workflow presents a GitHub OIDC token, and npm mints a
credential that expires with the run.

The trusted publisher is bound to the workflow **filename**. Renaming or moving
`.github/workflows/changesets.yml` revokes the credential, and the release then
fails with a `404` that reads like a missing package.

## Preflight — before merging a "Version Packages" PR

- [ ] `main` is green. No red required checks.
- [ ] The version bump matches the changesets it consumed. `feat` work should
      show a MINOR bump, fixes a PATCH.
- [ ] Read `CHANGELOG.md` in the PR diff as the release notes, because that is
      what they are. Every line should mean something to someone installing the
      CLI.
- [ ] The rollback line below is posted in the release thread **before** the
      merge.
- [ ] Someone can watch for 30 minutes after the merge.

## After the merge

1. **Watch the run.** `gh run watch` on the `Changesets` workflow. A failure
   before `changeset publish` means nothing was published; fix it and push to
   `main` again, and the same publish path re-runs.

2. **Smoke the published artifact** (≤5 minutes), against a clean prefix so you
   test what users install, not your working tree:

   ```sh
   npm install -g @uxfront/uxd@<new-version>
   uxd version          # must print the new version
   uxd --help           # every documented verb is listed
   uxd doctor
   ```

   Any failure → roll back now. Do not debug in front of users.

3. **Watch 30 minutes** for install reports and new issues.

4. **All clear or roll back**, posted with the evidence.

## Rollback

**An npm version is immutable. There is no true undo.** Plan around that, do not
argue with it.

**Inside 72 hours of publish**, and only if nothing depends on the version yet:

```sh
npm unpublish @uxfront/uxd@<bad-version>
```

npm blocks re-publishing that exact version afterwards, so the next attempt
needs a new number.

**After 72 hours, or if anything already installed it** — the real path:

```sh
npm deprecate @uxfront/uxd@<bad-version> "Broken: <one line>. Use <fix-version>."
npm dist-tag add @uxfront/uxd@<last-good> latest   # point new installs back
```

Deprecating warns on install; the `latest` dist-tag is what actually stops new
installs from landing on the bad version. Then ship the fix as a new patch
through the normal flow: a PR with a `patch` changeset, then the "Version
Packages" PR.

Delete the git tag and the GitHub release for the bad version only with the
repository owner's sign-off. The npm registry, not the tag, is what users
install from.

### Roll back when

- `uxd version` on the published package disagrees with the release → immediately.
- Any documented verb fails on a clean global install → immediately.
- `npm install -g` fails on a supported Node version (`>=18`) → immediately.

## Known failure modes

**`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` on install.** pnpm 11 refuses
lockfile entries published within the last day. It fires when a dependency was
released very recently. Wait for the entry to age out and re-run the workflow.
Do not relax the policy to get a release out — it is supply-chain protection,
and the release is never that urgent.

**`404` on publish.** Almost always the trusted publisher, not the package.
Check that the publisher registered on npmjs.com still names
`.github/workflows/changesets.yml`, and that `pnpm/action-setup` is v6 or later.

**"GitHub Actions is not permitted to create or approve pull requests."** The
repository setting *Allow GitHub Actions to create and approve pull requests* is
off, so the workflow cannot open the "Version Packages" PR. A repository admin
turns it on.

## Freeze

Do not merge a "Version Packages" PR when nobody can watch the result, or while
an incident is open. The rule is not a day of the week. The rule is that a human
is available to run the rollback.
