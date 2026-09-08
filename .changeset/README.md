# Changesets

This directory tracks intended-but-unreleased changes to `@uxfront/uxd`, the
only published package in this workspace. `apps/docs` is private and is never
versioned or published.

## How to record a change

When a PR changes anything that ships — `src/`, `bin/`, `package.json`,
`tsconfig.build.json`, `README.md`, or `DESIGN.md` — add a changeset:

```bash
pnpm changeset
```

Choose the SemVer bump (patch / minor / major) and write a one-line summary for
the person who installs the CLI, not for the person who wrote the code. Commit
the generated `.changeset/*.md` file with your PR.

CI blocks a PR that touches those paths without one.

Changed something that ships but has no consumer-visible effect — a script, a
comment, packaging metadata? Record that instead of skipping the step:

```bash
pnpm changeset --empty
```

An empty changeset satisfies the check and releases nothing.

## How a release happens

Releases run on `main` through `.github/workflows/changesets.yml`.

1. Your PR merges with a changeset in `.changeset/`. The workflow opens or
   updates a **"Version Packages"** PR that consumes every pending changeset,
   bumps `version` and writes `CHANGELOG.md`. It publishes nothing while a
   changeset is pending.
2. Merging the "Version Packages" PR empties `.changeset/`. The workflow runs
   again and **publishes** `@uxfront/uxd` if that version is not on the
   registry. It then pushes the git tag and creates the matching GitHub
   release.

Nobody pushes a release tag by hand. `changeset version` creates the version
commit, and `changeset publish` creates the tag and the GitHub release.

> [!WARNING]
> **Merging is publishing.** Any merge to `main` that leaves `.changeset/`
> empty releases to npm immediately. There is no second confirmation. Review a
> "Version Packages" PR as carefully as the code that produced it. You cannot
> undo an npm publish; you can only correct it with a new version.

Never edit `version` in `package.json` by hand. `changeset version` writes the
version and the changelog from the same source, so they cannot disagree.

## Credentials

Publishing uses **npm trusted publishing**. There is no npm token. The workflow
presents a GitHub OIDC token, and npm mints a credential that expires with the
run.

The trusted publisher is bound to the workflow **filename**. If you rename
`changesets.yml`, npm revokes the credential and the release fails with a `404`
that reads like a missing package.

## The packaging gate

`pnpm release` runs `pnpm run guard:packaging` before `changeset publish`. That
guard builds the CLI and asserts that every promised verb still resolves from
the built entrypoint. `1.0.0` shipped without `dist/src/commands/setup.js` and
`uxd setup` failed for everyone who installed it; this guard is why that cannot
reach the registry again. Do not move it out of the `release` script.
