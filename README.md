# uxd

Materialize any git ref of a configured project into an isolated, runnable local workspace with one command.

AI coding agents produce branches and PRs faster than they can be reviewed. `uxd` turns any ref — a PR number, a branch, a URL, or a local path — into a ready-to-run git worktree, so you can run the app, click through the UI, and poke at the change locally instead of reviewing blind.

```
uxd n8n 19234 code        # PR #19234 → worktree → open in editor
uxd n8n 19234 run dev     # same workspace → install deps → start dev server
uxd n8n clean --merged    # dispose of workspaces whose PRs merged
```

Every workspace command is the same pipeline:

```
resolve(ref) → materialize(workspace) → act(command)
```

## Status

This repository is under active development. The design document (`DESIGN.md`) is the source of truth for behavior and scope.

**M0 (this milestone) — "usable in one evening":**

- CLI parse + classification, config load + `config validate`, errors/exit codes, stdout/stderr contract.
- Primary repo init (bare partial clone), branch + same-repo PR checkout, push-back wiring when `gh` is present.
- Verbs: `checkout`, `code` (zed/code/cursor/terminal), `list`, `rm`, `clean` (explicit slugs + `--all`), `projects`, `doctor`, `--dry-run`.
- State file + per-project locking.

Later milestones add the setup pipeline, `run`/`exec`/`shell`, `sync`, hooks, port allocation, `gh` metadata, `diff`, and completions.

## Requirements

- [Bun](https://bun.sh) ≥ 1.1
- `git` ≥ 2.38
- `gh` (optional — enables PR metadata and push-back wiring)

## Development

```bash
bun install
bun test          # unit + integration
bun run typecheck # tsc --noEmit
bin/uxd help
```

## Configuration

`uxd` reads per-project TOML files from `${XDG_CONFIG_HOME:-~/.config}/uxd` (override with `--config-dir` or `$UXD_CONFIG_DIR`). Run `uxd doctor` to diagnose your environment and `uxd config validate` to check your project files.

See `DESIGN.md` for the full specification.
