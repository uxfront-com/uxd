# uxd — unpack, execute, debug

Materialize any git ref of a configured project into an isolated, runnable local workspace with one command.

AI coding agents produce branches and PRs faster than they can be reviewed. `uxd` turns any ref — a PR number, a branch, a commit, a URL, or a local path — into a ready-to-run git worktree, so you can run the app, click through the UI, and poke at the change locally instead of reviewing blind.

```
uxd my-project 42 code        # PR #42 → worktree → open in editor
uxd my-project 42 run dev     # same workspace → install deps → start dev server
uxd my-project clean --merged # dispose of workspaces whose PRs merged
```

Every workspace command is the same pipeline:

```
resolve(ref) → materialize(workspace) → act(command)
```

- **resolve** — turn a ref (PR number, branch, commit, URL, or path) into a concrete git target.
- **materialize** — ensure a worktree exists for that target, with dependencies installed, seed files copied, and ports allocated. Idempotent and cheap when already materialized.
- **act** — open an editor, run a configured command, exec an arbitrary command, drop into a shell, diff, or sync.

`checkout` is the pipeline with a no-op act step; every other verb is a thin wrapper over it.

## Requirements

- [Node.js](https://nodejs.org) ≥ 18
- `git` ≥ 2.38
- `gh` (optional — enables PR metadata in `list`/`info`, `gh pr diff`, and fork push-back; every `gh` feature degrades gracefully when it is missing)

`uxd` runs on stock Node — no Bun, Deno, or other runtime required. Any package manager (npm, pnpm, yarn) installs it.

## Install

`uxd` ships as compiled JavaScript, so installing from a clone has two steps: install dependencies, then build the `dist/` output that the CLI runs from.

### Global install (recommended)

Clone the repo, build, and link it onto your `PATH`:

```bash
git clone git@github.com:uxfront-com/uxd.git
cd uxd
npm install
npm run build           # emits dist/bin/uxd.js (the linked bin points here)
npm link                # puts `uxd` on your PATH
uxd version             # → uxd 0.0.0
```

`npm link` points `uxd` at your clone's `dist/`. Because the CLI runs compiled output, **re-run `npm run build` after a `git pull`** to pick up new changes.

### Other package managers

Prefer pnpm or yarn? Install and build the same way, then use that tool's global-link command:

```bash
pnpm install && pnpm run build && pnpm link --global    # pnpm (run `pnpm setup` once first)
yarn install && yarn run build && yarn global add "file:$PWD"   # yarn (classic)
```

Then confirm the tool's global bin directory is on your `PATH` — `$(npm prefix -g)/bin` (npm), `$(pnpm bin -g)` (pnpm), or `$(yarn global bin)` (yarn) — and run `uxd version`.

### Run without installing

Skip the global step and call the built entrypoint from the clone:

```bash
npm install && npm run build
node dist/bin/uxd.js version    # → uxd 0.0.0
```

The examples below use `uxd`; substitute `node dist/bin/uxd.js` if you have not linked it globally.

## Quick start

1. Point `uxd` at a project. By default `uxd` reads its config from `~/.uxd` (override with `UXD_CONFIG_DIR` or `--config-dir`):

   ```bash
   uxd config path                     # → ~/.uxd
   uxd config add my-project           # open (or create) ~/.uxd/my-project.toml
   ```

   A minimal `my-project.toml`:

   ```toml
   repo = "git@github.com:my-org/my-project.git"
   editor = "code"

   [setup]
   run = "pnpm install --frozen-lockfile"
   cache_key = ["pnpm-lock.yaml"]

   [commands.dev]
   run = "pnpm dev"
   ```

   (`repo_path`/`worktrees_path` default to `{root}/{project}/…`; set `root` in `defaults.toml` — see [Configuration](#configuration).)

2. Check your setup and validate the config:

   ```bash
   uxd doctor
   uxd config validate
   ```

3. Materialize a PR and open it:

   ```bash
   uxd my-project 42 code
   ```

4. Run its dev server in the same workspace, then clean up when the PR merges:

   ```bash
   uxd my-project 42 run dev
   uxd my-project clean --merged
   ```

## Refs

A **ref** is what you want to materialize. `uxd` parses the ref positional in this order (first match wins):

| Input | Meaning | Example |
|---|---|---|
| `<n>` or `#<n>` | pull request | `uxd my-project 42`, `uxd my-project '#42'` |
| `pr/<n>` | pull request (case-insensitive) | `uxd my-project pr/42` |
| `/`, `./`, `../`, or `~`-prefixed | adopt an existing working tree | `uxd my-project ~/code/checkout shell` |
| 40-char hex | commit SHA (detached worktree) | `uxd my-project 1a2b3c…<40 chars>` |
| `-` | the last-used ref for this project | `uxd my-project - shell` |
| anything else valid as a branch | branch name | `uxd my-project feat/login code` |

Short SHAs are deliberately **not** auto-detected (they collide with hex-ish branch names) — use the full 40 characters or force interpretation with a flag.

**Force a ref's kind** with a disambiguator (bypasses the table above):

```bash
uxd my-project --pr 42 code            # treat 42 as a PR
uxd my-project --branch 42 code        # treat 42 as a branch literally named "42"
uxd my-project --path ./here shell     # adopt ./here
```

**URL form** — pass a clone or web URL in place of the project name; `uxd` matches it to the project whose `repo` has the same host/owner/repo (ssh ↔ https, `.git` optional). A `/pull/<n>` or `/tree/<branch>` segment is consumed as the ref:

```bash
uxd https://github.com/my-org/my-project/pull/42 code
uxd https://github.com/my-org/my-project/tree/feat/login diff
uxd git@github.com:my-org/my-project.git 42 code      # ref given separately
```

## Command grammar

```
uxd [global flags] <project|url> <ref> [verb] [args] [-- passthrough]   # workspace commands
uxd [global flags] <project> <project-verb> [args]                      # project commands
uxd [global flags] <top-level-verb> [args]                              # global commands
```

- Everything after the first bare `--` is passed verbatim to the underlying command (`run`, `exec`, `diff`).
- Omit the verb and `uxd` uses the project's `default_command` (config; `code` by default): `uxd my-project 42` ≡ `uxd my-project 42 code`.
- A bare `uxd <project>` lists the project's workspaces — or opens an [interactive picker](#interactive-picker) on a TTY.
- If the verb slot names one of your `[commands.*]` entries, it is sugar for `run <name>`: `uxd my-project 42 dev` ≡ `uxd my-project 42 run dev`.

## Commands

### Workspace verbs

Require a project and a ref.

| Verb | Purpose |
|---|---|
| `checkout` | Materialize only; print the worktree path |
| `code` | Materialize; open the workspace in your editor |
| `run <name>` | Materialize + setup; run a configured command |
| `exec -- <argv…>` | Materialize + setup; run an arbitrary command |
| `shell` | Materialize + setup; open an interactive shell in the workspace |
| `sync` | Re-fetch and reset the workspace to its ref |
| `diff` | Show the workspace's diff vs. its base |
| `info` | Print one workspace's details |
| `rm` | Remove one workspace |

**`checkout`** — the scriptable primitive. Prints the absolute worktree path (one line, nothing else) so it composes:

```bash
cd "$(uxd my-project 42 checkout)"
uxd my-project 42 checkout --json          # {"project":"my-project","slug":"pr-42",...}
uxd my-project 42 checkout --fetch         # force a re-fetch before materializing
uxd my-project 42 checkout --setup         # also run [setup] (off by default here)
```

**`code`** — opens the workspace, materializing it first if needed:

```bash
uxd my-project 42 code
uxd my-project 42 code --editor vim        # override the configured editor for this run
```

**`run <name>`** — materializes, runs `[setup]`, then the named command in the worktree. Passthrough args are appended to the command; `--env`/`--port` override the environment for this invocation only:

```bash
uxd my-project 42 run dev
uxd my-project 42 run dev --port 6000
uxd my-project 42 run test -- --watch      # args after -- go to the command
uxd my-project 42 run dev --env DEBUG=1 --no-setup
```

Flags: `--no-setup` (skip `[setup]`), `--reseed` (re-copy seed files), `--fetch` (re-fetch first), `--port <n>`, `--env K=V` (repeatable).

**`exec -- <argv…>`** — like `run`, but for an ad-hoc command spawned directly (no shell):

```bash
uxd my-project 42 exec -- pnpm test
uxd my-project 42 exec --no-setup -- git log --oneline -5
```

**`shell`** — an interactive shell in the workspace, with the full uxd environment (`$UXD_PORT`, `$UXD_PATH`, …) exported:

```bash
uxd my-project 42 shell
uxd my-project - shell                     # the last-used ref
```

**`sync`** — re-fetch the ref and hard-reset the worktree to it. Choose how to treat local changes:

```bash
uxd my-project 42 sync                      # refuses if the tree is dirty
uxd my-project 42 sync --stash              # stash changes, then reset
uxd my-project 42 sync --discard            # discard changes, then reset
uxd my-project 42 sync --fresh              # remove and re-materialize from scratch
```

`--stash`, `--discard`, and `--fresh` are mutually exclusive.

**`diff`** — for a PR workspace with `gh` available, renders `gh pr diff` against the real PR base; otherwise `git diff <merge-base>...HEAD` in the worktree:

```bash
uxd my-project 42 diff
uxd my-project 42 diff --stat
uxd my-project 42 diff --tool               # use git difftool (always local)
uxd my-project 42 diff -- --color-words     # extra args go to gh/git
```

**`info`** / **`rm`**:

```bash
uxd my-project 42 info
uxd my-project 42 info --du                 # include on-disk size
uxd my-project 42 info --json
uxd my-project 42 rm                        # remove one workspace (prompts unless --yes)
uxd my-project 42 rm --force --yes          # remove even if dirty, no prompt
```

### Project verbs

Require a project, no ref.

**`list`** — the project's workspaces. For PR workspaces, `STATUS` shows the PR state plus a CI mark (`✓` pass / `✗` fail), refreshed from `gh` stale-while-revalidate (bounded to ~2s; the table always renders):

```bash
uxd my-project list
uxd my-project list --du                    # add a disk-usage column
uxd my-project list --json                  # deterministic, offline (no gh refresh)
```

```
SLUG      KIND    BRANCH      STATUS   PORT  AGE  LAST USED
pr-42     pr      feat/login  open ✓   5700  5m   just now
feat-ui   branch  feat/ui     dirty    5701  2h   1h
```

**`clean`** — remove workspaces by explicit slug or by filter (explicit slugs and filters cannot be combined):

```bash
uxd my-project clean pr-42                   # explicit slug(s)
uxd my-project clean --all
uxd my-project clean --merged                # branch merged into the default branch (git-only)
uxd my-project clean --closed                # PR closed or merged (prefers gh, falls back to git)
uxd my-project clean --older-than 7d         # idle ≥ 7d (s/m/h/d/w units)
uxd my-project clean --prune-state           # drop state entries whose worktree is gone
uxd my-project clean --merged --yes          # skip the confirmation prompt
```

Filters intersect. Dirty worktrees are skipped unless `--force`; adopted workspaces are excluded unless `--include-adopted`. `clean` prints a plan and asks for confirmation (pass `--yes` for non-interactive use).

### Top-level verbs

No project argument.

```bash
uxd projects                                 # list configured projects
uxd doctor                                   # diagnose environment & configs
uxd config path                              # print the config dir
uxd config edit [project]                    # edit defaults or a project file
uxd config add [project]                     # alias of `config edit`
uxd config validate [project]                # validate all configs, or one
uxd completions <bash|zsh|fish>              # print a completion script
uxd help                                     # usage
uxd version                                  # version string
```

**`doctor`** checks `git` version, `gh` presence/auth, config-dir readability, state-dir writability, stale locks, and — per project — schema validity, the bare repo and its fetch refspec, editor binary on `PATH`, commands that shadow built-in verbs, and worktree/state drift. It also warns when `core.hooksPath` is set (see [Worktrees & hooks](#worktrees--hooks)). Exits non-zero if any check fails.

**`completions`** bakes in the verb vocabulary and your current project names; workspace slugs are completed live via `uxd <project> list --json`. Install for the session:

```bash
# bash
eval "$(uxd completions bash)"
# zsh
eval "$(uxd completions zsh)"
# fish
uxd completions fish | source
```

### Interactive picker

On a TTY, a bare `uxd <project>` lists the workspaces and prompts you to pick one; the chosen workspace's path is printed to stdout, so it composes with `cd`:

```bash
cd "$(uxd my-project)"
```

Non-interactive (no TTY) or `--json` falls back to a plain `list`. An empty answer cancels.

## Global flags

| Flag | Effect |
|---|---|
| `--config-dir <dir>` | Override the config directory |
| `--pr` / `--branch` / `--path <v>` | Force how the ref is interpreted |
| `--dry-run` | Print what would run; change nothing |
| `--json` | Machine-readable stdout (`checkout`, `list`, `info`, `projects`, `doctor`) |
| `-q`, `--quiet` | Suppress step logs |
| `-v`, `--verbose` | Print external commands (also enables debug traces) |
| `-y`, `--yes` | Assume "yes" for prompts |
| `--no-color` | Disable ANSI color |

`--dry-run` is available on every mutating command. For `run`/`exec`/`shell` it prints the computed environment as `export` lines followed by the shell-quoted command, so you can see exactly what would execute:

```bash
uxd my-project 42 run dev --dry-run
uxd my-project 42 sync --discard --dry-run
uxd my-project 42 diff --dry-run
```

## Configuration

`uxd` reads per-project TOML files from the config dir, resolved as:

```
--config-dir → $UXD_CONFIG_DIR → ~/.uxd
```

### Layout

```
<config-dir>/
  defaults.toml            # optional global defaults
  my-project.toml          # one file per project; filename = project name
  seeds/
    my-project/            # seed file tree for project "my-project"
      .env.local
```

Project names must match `^[a-z0-9][a-z0-9._-]*$`. `defaults` and `seeds` are reserved names.

### `defaults.toml`

```toml
root = "~/dev/uxd"          # base dir for derived repo_path / worktrees_path
editor = "zed"              # fallback editor preset or template
default_command = "code"    # fallback default verb
```

All keys optional. `env` and `commands` are not allowed here (keep per-project config self-contained).

### Project file

```toml
# ── Repository ────────────────────────────────────────────────
repo = "git@github.com:my-org/my-project.git"  # required. ssh or https.
repo_path = "~/dev/uxd/my-project/repo"         # optional. default: {root}/{project}/repo
worktrees_path = "~/dev/uxd/my-project/trees"   # optional. default: {root}/{project}/trees
default_branch = "main"                         # optional. default: auto-detect from origin HEAD

# ── Behavior ──────────────────────────────────────────────────
editor = "zed"                                  # optional. preset name or template
default_command = "code"                        # optional. verb or configured command name
ports = 1                                        # optional. contiguous ports per workspace, 1–10
base_port = 5700                                 # optional. default: derived per-project

# ── Setup (runs after checkout, before run/exec/shell) ────────
[setup]
run = "pnpm install --frozen-lockfile"          # optional. skipped entirely when absent
cache_key = ["pnpm-lock.yaml", "**/package.json"]  # globs; setup re-runs when they change
seed_files = [".env.local"]                     # relative paths seeded into the worktree
seed_from = "~/dev/my-project"                  # optional extra seed source

# ── Environment for run/exec/shell/hooks (templated) ──────────
[env]
PORT = "{port}"
VITE_BASE_URL = "http://localhost:{port}"

# ── Named commands ────────────────────────────────────────────
[commands.dev]
run = "pnpm dev"                                # required. templated
cwd = "packages/app"                            # optional, relative to the worktree root
[commands.dev.env]
NODE_OPTIONS = "--max-old-space-size=8192"

[commands.test]
run = "pnpm test"

# ── Hooks ─────────────────────────────────────────────────────
[hooks]
post_checkout = "echo 'workspace ready: {path}'"
# pre_run, post_sync, pre_clean are the other three hook names
```

Path values support leading `~` expansion only. Validation is aggregate — `config validate` reports every schema error in a file at once.

### Template variables

Interpolated (single pass, `{name}` syntax; `{{` escapes a literal `{`) in `[env]` values, `commands.*.run`, `commands.*.cwd`, `hooks.*`, and editor templates:

| Variable | Value |
|---|---|
| `{path}` | Absolute worktree path |
| `{repo_path}` | Absolute primary-repo path |
| `{data_dir}` | Per-workspace data dir |
| `{project}` | Project name |
| `{ref}` | Original ref string as typed |
| `{branch}` | Resolved branch name (or short SHA when detached) |
| `{slug}` | Workspace slug |
| `{port}` | First allocated port |
| `{port+N}` | `port + N`, valid for `N < ports` (e.g. `{port+1}`) |

The same values are always exported to child processes as `UXD_PATH`, `UXD_REPO_PATH`, `UXD_DATA_DIR`, `UXD_PROJECT`, `UXD_REF`, `UXD_BRANCH`, `UXD_SLUG`, `UXD_PORT`, and `UXD_PORT_1…UXD_PORT_{ports-1}`, whether or not your config references them.

### Editors

`editor` accepts a preset name — `zed`, `code`, `cursor`, `windsurf`, `idea`, `webstorm`, `phpstorm`, `goland`, `vim`, `nvim`, `helix`, `hx`, or `terminal` — or a custom template containing `{path}`. Append `:wait` to a template to keep uxd in the foreground until the editor exits:

```toml
editor = "emacsclient -n {path}"
editor = "kak {path}:wait"
```

## GitHub integration

When `gh` is installed and authenticated, `uxd` enriches — but never depends on — the core git flow:

- `list` and `info` show PR state and CI status, refreshed stale-while-revalidate and bounded so the command never blocks.
- `diff` on a PR workspace renders `gh pr diff` against the true PR base.
- `clean --closed` uses `gh`'s authoritative PR state, falling back to cached state, then to the git-only merged heuristic.
- Fork PRs get push-back wiring so your local commits can be pushed to the contributor's branch.

Without `gh`, all of the above degrade gracefully: PR checkout of `refs/pull/<n>/head` still works against GitHub and GitHub Enterprise, and `diff`/`clean` fall back to git. `doctor` reports `gh`'s status.

## Worktrees & hooks

`uxd` owns one **bare, partial clone** per project and creates one **git worktree** per ref. A few consequences are worth knowing:

- **`.git` in a worktree is a file, not a directory** — it points back at the primary repo. Tooling that assumes a `.git` directory (some Docker volume setups, older scripts) can trip on this. Nothing for uxd to fix; just be aware.
- **`core.hooksPath` / husky.** Repos that configure relative hook paths (as husky does) can resolve them incorrectly from a worktree, and `pnpm install` may try to install hooks into the bare repo. `doctor` warns when `core.hooksPath` is set — it does not modify your repo.
- **Partial clones fetch lazily.** The first checkout of a worktree, and a `diff` across not-yet-fetched trees, need network access. Offline use is degraded by design.
- **A branch already checked out** in another worktree cannot be checked out again; `uxd` points you at the existing workspace.
- **Manually `rm -rf`-ing a worktree** leaves git metadata behind. `clean` runs `git worktree prune`, and `doctor` flags the drift — reconcile with `uxd <project> clean --prune-state`.

## Exit codes

| Code | Name | Meaning |
|---|---|---|
| 0 | success | — |
| 1 | internal | unexpected error |
| 2 | usage | bad flags or arguments |
| 3 | config | invalid config or unknown project |
| 4 | resolve | ref could not be resolved |
| 5 | git | git (or gh) plumbing failure |
| 6 | setup | `[setup]` command failed |

Errors print as `error(E_CODE): message` on stderr, with a `hint:` line when one applies.

## Development

```bash
npm install
npm test                       # unit + integration (vitest)
npm run typecheck              # tsc --noEmit
npm run build                  # emit dist/
node dist/bin/uxd.js help      # run the built CLI
```

`DESIGN.md` is the source of truth for behavior and scope. See `docs/adrs/` for architecture decision records.
