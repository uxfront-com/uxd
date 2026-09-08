# Changelog

All notable changes to [`@uxfront/uxd`](https://www.npmjs.com/package/@uxfront/uxd)
are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] — 2026-09-07

### Removed

- **Breaking — `extends` in project files is gone.** 1.0.0 accepted an optional
  `extends` key that pointed a project file at a repo-committed base config, plus
  a `uxd config link <name> --from <path>` command to scaffold that pointer. Both
  were reverted. Project files are validated strictly, so a leftover `extends`
  key now fails every command that loads the config:

  ```bash
  uxd config validate my-project
  ```

  ```
  my-project.toml: (root): Unrecognized key(s) in object: 'extends'
  ```

  **To migrate:** open the project file with `uxd config edit my-project`, delete
  the `extends` line, and copy any keys you relied on from the referenced file
  into the project file.

  The `uxd config link` subcommand is gone with it:

  ```
  error(E_USAGE): unknown config subcommand 'link'
  hint: expected: path | edit | add | validate
  ```

  Config layering may return in a later release. Follow
  [the project file reference](https://github.com/uxfront-com/uxd/blob/main/apps/docs/content/docs/configuration/02.project-file.md)
  for the keys that are supported today.

### Added

- **`uxd setup` — first-run onboarding in one command.** On a fresh machine it
  creates the config directory (`~/.uxd` by default), sets a base `root` so
  derived paths resolve, and writes your first project file. It is the only
  command exempt from the config-directory existence check, because it is what
  creates the directory. On a terminal it prompts for each field; every prompt is
  also a flag, so the same command runs unattended in CI:

  ```bash
  uxd setup \
    --config-dir ./ci-config \
    --name acme-web \
    --repo git@github.com:acme/acme-web.git \
    --default-branch main \
    --yes
  ```

  ```
  → created config dir ./ci-config
  → set defaults.root = ~/dev/uxd
  → scaffolded acme-web.toml
  → next: uxd acme-web main
  ```

  `--dry-run` prints the planned writes and changes nothing. An existing project
  file is refused with `E_CONFIG` unless you pass `--force`. See
  [the top-level verb reference](https://github.com/uxfront-com/uxd/blob/main/apps/docs/content/docs/cli/04.top-level-verbs.md)
  for the full prompt and flag reference.

- **`uxd config add` seeds a starter template.** Opening a project file that does
  not exist used to drop you into an empty buffer, so you had to know the TOML
  schema by heart. `add` (and `edit`) now writes a commented template first —
  only `repo` is uncommented — so a valid config is one edit away. Existing files
  are never touched, and `--dry-run` prints the template plus the editor command
  without creating anything. Reserved or malformed project names now exit with a
  usage error and write nothing, which `edit` previously skipped.

### Fixed

- **`uxd version` printed `uxd 0.0.0`.** The version lookup matched the package
  name `uxd` while the manifest declares `@uxfront/uxd`, so it never matched and
  always fell back. It now reports the real version:

  ```bash
  uxd version
  ```

  ```
  uxd 1.1.0
  ```

- **`uxd doctor` missed hand-deleted workspaces.** The orphan check compared uxd
  state against `git worktree list` only. Git does not prune automatically, so a
  workspace you removed with `rm -rf` stayed listed and the warning never fired.
  `doctor` now also checks the filesystem.

- **`uxd doctor` warned forever when `worktrees_path` crossed a symlink** — `/tmp`
  on macOS, for example. Git prints resolved paths, so every entry mismatched and
  the false warnings drowned out real drift. Both sides are now canonicalized.

- **`uxd doctor` named the editor binary inconsistently** and warned on healthy
  machines. It printed the resolved binary in one half of the message and a
  hardcoded `code` in the other, and it searched `PATH` for binaries given as
  absolute paths — so the `terminal` preset (`$SHELL`) warned every run.

## [1.0.0] — 2026-07-24

First published release on npm as `@uxfront/uxd`.

> [!WARNING]
> **1.0.0 has no `uxd setup` command.** The verb did not exist yet, so the CLI
> reads `setup` as a project name and fails:
>
> ```
> error(E_CONFIG): unknown project 'setup'
> ```
>
> This is not a configuration problem. Upgrade to 1.1.0 or later:
>
> ```bash
> npm i -g @uxfront/uxd@latest
> ```
>
> Confirm the upgrade with `uxd version`. On 1.0.0 that command reports
> `uxd 0.0.0` (see the version fix above), so any other output means the upgrade
> landed. 1.1.0 adds a packaging test that fails the build if a top-level verb is
> ever missing from the published artifact again.

Entries before 1.1.0 are not itemized. This file starts at the 1.1.0 release; for
earlier history read the
[commit log](https://github.com/uxfront-com/uxd/commits/main).

[Unreleased]: https://github.com/uxfront-com/uxd/compare/5be2696...HEAD
[1.1.0]: https://github.com/uxfront-com/uxd/compare/ce722ab...5be2696
[1.0.0]: https://github.com/uxfront-com/uxd/commit/ce722ab
