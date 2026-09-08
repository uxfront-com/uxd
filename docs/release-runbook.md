# Release runbook

`@uxfront/uxd` is published to npm by `.github/workflows/release.yml`. The
workflow runs on a pushed tag that matches `v*`, and it publishes only if every
gate passes.

**The workflow publishes. It does not tag.** A release therefore has two actors:

| Step | Who |
|---|---|
| Open the version-bump PR | Anyone (a maintainer or an agent) |
| Merge the version-bump PR | The repository owner |
| **Cut and push the tag** | **The repository owner** |
| Publish to npm | The `Release` workflow |
| Call the release good, or roll it back | The repository owner |

Nobody publishes by hand. A local `npm publish` bypasses every gate below. The
repository had no release workflow when `1.0.0` shipped, and that tarball reached
npm without `dist/src/commands/setup.js` — `uxd setup` failed for every user who
installed it.

The first tag pushed through this workflow must carry a version that is not on
npm yet. `1.1.0` is already published and npm will not accept it again.

## What the workflow checks before it publishes

The job fails, and nothing reaches npm, if any of these fail.

1. **`NPM_TOKEN` is set.** An automation token with publish rights on
   `@uxfront/uxd`, stored as a repository Actions secret. Only a repository
   admin can add or rotate it.
2. **The tag is on `main`.** A tag on a side branch is refused.
3. **`npm ci`, `npm run typecheck`, `npm run build`** succeed.
4. **The packaging guard passes** — `test/integration/packaging.test.ts`. It
   rebuilds, then runs the *built* entrypoint and asserts that every promised
   verb resolves as a verb rather than as a project name, and that
   `dist/src/commands/setup.js` exists. A verb that stops shipping fails the
   release here. This is the gate the `1.0.0` defect would have tripped.
5. **The full test suite passes** — `npm test`.
6. **The tag, `package.json`, and `uxd version` agree.** Tag `v1.2.0` requires
   `package.json` version `1.2.0` and `uxd version` printing `uxd 1.2.0`.

The published tarball carries [npm provenance](https://docs.npmjs.com/generating-provenance-statements),
so the artifact on npm is traceable to this workflow run and commit.

## Preflight

- [ ] `main` is green. No red required checks.
- [ ] Read the release diff as a whole: `git log v<prev>..main --oneline`. The
      repository carries no tags before this workflow, so use the commit the last
      published version was built from until `v<prev>` exists.
- [ ] The version bump matches the commit grammar over that range — `feat` means
      MINOR, `fix` means PATCH, a `!` or a `BREAKING CHANGE` footer means MAJOR.
      Commits that touch only `apps/docs` do not ship in the package and do not
      justify a bump on their own.
- [ ] The bump is merged to `main` as its own `chore(release): X.Y.Z` PR, so the
      tag has a commit to point at.
- [ ] Release notes are drafted for the same version.
- [ ] The rollback line below is posted in the release thread **before** the tag
      is pushed.
- [ ] Someone can watch for 30 minutes after the publish.

### Rehearsal

Run the whole gate without publishing:

```sh
gh workflow run release.yml --ref v1.2.0 -f dry_run=true
```

This runs every check and ends at `npm publish --dry-run`. Nothing is uploaded.
A dry run needs no credential, so it works before `NPM_TOKEN` is added. Use it
after any change to the workflow, and on a tag you are unsure about.

Rehearsing against a version that is already on npm ends with
`You cannot publish over the previously published versions` — that is npm
refusing the last step, and it means every gate before it passed.

## The sequence

1. **Announce** in the release thread: the version, one line of contents, the
   rollback line, and the watch window.

2. **Cut the tag** (repository owner only), from `main` at the release commit:

   ```sh
   git checkout main && git pull
   git tag -a v1.2.0 -m "v1.2.0"
   git push origin v1.2.0
   ```

   Annotated, not lightweight. The tag name is `v` plus the exact
   `package.json` version.

3. **Watch the run**: `gh run watch` on the `Release` workflow. A failure here
   means nothing was published — fix the cause and push a corrected tag. Do not
   move a tag that a run has already consumed; cut the next patch version
   instead.

4. **Smoke the published artifact** (≤5 minutes), against a clean prefix so you
   test what users install, not your working tree:

   ```sh
   npm install -g @uxfront/uxd@1.2.0
   uxd version          # must print: uxd 1.2.0
   uxd --help           # every documented verb is listed
   uxd doctor
   ```

   Any failure → roll back now. Do not debug in front of users.

5. **Watch 30 minutes** for install reports and new issues.

6. **All clear or roll back**, posted with the evidence.

## Rollback

**An npm version is immutable. There is no true undo.** Plan around that, do not
argue with it.

**Inside 72 hours of publish**, and only if nothing depends on the version yet:

```sh
npm unpublish @uxfront/uxd@1.2.0
```

npm blocks re-publishing that exact version afterwards, so the next attempt
needs a new number.

**After 72 hours, or if anything already installed it** — the real path:

```sh
npm deprecate @uxfront/uxd@1.2.0 "Broken: <one line>. Use 1.2.1."
npm dist-tag add @uxfront/uxd@<last-good> latest   # point new installs back
```

Then ship the fix as a new patch version through this same runbook. Deprecating
warns on install; the `latest` dist-tag is what actually stops new installs from
landing on the bad version.

### Roll back when

- `uxd version` on the published package disagrees with the tag → immediately.
- Any documented verb fails on a clean global install → immediately.
- `npm install -g` fails on a supported Node version (`>=18`) → immediately.

## Hotfix

Branch from the released tag, not from `main`, when `main` has moved on:

```sh
git checkout -b hotfix/1.2.1 v1.2.0
```

Keep the diff minimal, bump the PATCH version in the same branch, open a PR, and
land it on `main`. Then cut `v1.2.1` through the normal sequence. The full gate
still runs; a hotfix does not skip the packaging guard.

## Freeze

Do not cut a tag when nobody can watch the result, or while an incident is open.
The rule is not a day of the week. The rule is that a human is available to run
the rollback.
