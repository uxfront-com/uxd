# Testlane — Design Document

**Status:** Ready for implementation
**Audience:** Implementing engineer / coding agent (Claude Code). This document is the source of truth; where it makes a decision, follow it. Where behavior is unspecified, prefer the simplest option consistent with §13 (Output & UX conventions) and leave a `// DESIGN: unspecified` comment.

---

## 1. Problem & overview

AI coding agents produce branches and PRs faster than they can be reviewed on GitHub. Reading diffs in a browser is reviewing blind: you can't run the app, click through the UI, or poke at the change locally without a manual clone/fetch/checkout/install/env-setup dance — multiplied by every concurrent agent branch, and colliding with your own working copy.

**Testlane** is a CLI that materializes any ref of a configured project into an isolated, runnable local workspace with one command:

```
testlane n8n 19234 code      # PR #19234 → worktree → open in editor
testlane n8n 19234 run dev   # same workspace → install deps → start dev server
testlane n8n clean --merged  # dispose of workspaces whose PRs merged
```

### Core abstraction

Every workspace command is the same pipeline:

```
resolve(ref) → materialize(workspace) → act(command)
```

- **resolve** — turn a user-supplied ref (PR number, branch name, URL, filesystem path) into a concrete git target.
- **materialize** — ensure a git worktree exists for that target, with dependencies installed, untracked files seeded, ports allocated, and env computed. Idempotent; cheap when already materialized.
- **act** — open an editor, run a configured command, exec an arbitrary command, drop into a shell, diff, sync, etc.

`checkout` is the pipeline with a no-op act step. Implement the pipeline once as `ensureWorkspace(project, refSpec): Workspace` and every command becomes a thin wrapper.

### Isolation model

- One **bare, partial clone** per project (the "primary repo") owned by Testlane — never the user's daily checkout.
- One **git worktree** per ref, in a flat directory of disposable workspaces.
- One **data dir** and **port block** per workspace, so multiple instances run concurrently without collisions.

---

## 2. Goals & non-goals

### Goals

1. One command from "agent pushed a branch/PR" to "app running locally / open in my editor".
2. Concurrent workspaces for the same project that do not fight over ports, databases, or caches.
3. Cheap disposal: workspaces are cattle; `clean` reclaims disk and git state safely.
4. Scriptable: stable stdout contracts and `--json` so Testlane composes with other automation (e.g. an n8n workflow that posts `testlane n8n 19234 code` into Slack).
5. Fast repeat use: setup (dependency install) is cached and skipped when lockfiles are unchanged.
6. Trustworthy: `--dry-run` shows exactly what would execute; `doctor` diagnoses the environment.

### Non-goals (v1)

- Process supervision beyond one detached process per workspace (`start`, `stop`, `logs`, `ps`, §9.14–9.17). Testlane doesn't restart a crashed process, reap orphans or orchestrate services.
- File watching / auto-sync on new commits — the calling automation's job.
- Docker / docker-compose service orchestration per workspace.
- Native Windows. WSL2 is expected to work; do not add Windows-specific code paths.
- Multi-VCS. Git only. GitHub-specific features (PR metadata, fork PRs) degrade gracefully when `gh` is unavailable; core checkout of `refs/pull/N/head` works against GitHub and GitHub Enterprise without `gh`.
- A TUI. Line-oriented output only (an interactive picker is M2, built on `list --json`).

---

## 3. Terminology

| Term | Meaning |
|---|---|
| **project** | A named configuration (`<name>.toml` in the config dir) pointing at one git repository. |
| **primary repo** | The Testlane-owned bare partial clone at `repo_path`. Never opened in an editor, never has a working tree. |
| **ref** | User input identifying what to materialize: PR number, branch, commit SHA, URL, `-`, or a filesystem path. |
| **RefSpec** | The parsed, typed form of a ref (see §6). |
| **workspace** | A materialized ref: worktree directory + state entry + data dir + port block. |
| **slug** | Filesystem-safe identifier for a workspace, derived from the ref (§6.3). Directory name and state key. |
| **adopted workspace** | A workspace created from a `path` ref — an existing directory Testlane runs commands in but does not lifecycle-manage. |
| **verb** | A Testlane subcommand (`checkout`, `code`, `run`, `list`, …). |

---

## 4. CLI grammar

### 4.1 Synopsis

```
testlane [global flags] <project|url> <ref> [verb [args...]] [-- passthrough...]  # workspace commands
testlane [global flags] <project> <project-verb> [args...]                   # project commands
testlane [global flags] <top-verb> [args...]                                 # global commands
```

### 4.2 Verb tables

**Top-level verbs** (no project argument):

| Verb | Purpose | Spec |
|---|---|---|
| `projects` | List configured projects | §9.10 |
| `doctor` | Diagnose environment & configs | §9.11 |
| `config` | `edit\\|path\\|validate [project]` | §9.12 |
| `completions <shell>` | Print shell completion script (M2) | §9.13 |
| `mcp` | Serve Testlane's tools to an MCP client over stdio | §9.18 |
| `help`, `--help`, `-h` | Usage | — |
| `version`, `--version`, `-V` | Version string to stdout | — |

**Project verbs** (require project, no ref):

| Verb | Purpose | Spec |
|---|---|---|
| `list` | List workspaces for the project | §9.8 |
| `clean` | Remove workspaces by filter | §9.9 |
| `ps` | List the processes `start` left running | §9.17 |

**Workspace verbs** (require project + ref):

| Verb | Purpose | Spec |
|---|---|---|
| `checkout` | Materialize; print path | §9.1 |
| `code` | Materialize; open editor | §9.2 |
| `run <name>` | Materialize + setup; run configured command | §9.3 |
| `exec -- <argv...>` | Materialize + setup; run arbitrary argv | §9.4 |
| `shell` | Materialize + setup; interactive shell in workspace | §9.5 |
| `sync` | Update workspace to latest remote state | §9.6 |
| `diff` | Show the workspace's diff vs. its base | §9.7 |
| `info` | Print workspace details (`--json` capable) | §9.8 |
| `rm` | Remove this one workspace (single-target `clean`) | §9.9 |
| `start <name>` | Materialize + setup, then run a configured command detached and return once its port accepts | §9.14 |
| `stop` | Stop the process `start` left running | §9.15 |
| `logs [-f]` | Print or follow that process's log | §9.16 |

### 4.3 Argument classification algorithm

Implement exactly this, in `src/cli/parse.ts`:

1. **Tokenize.** Scan argv left to right. The first bare `--` token ends Testlane parsing; every subsequent token is collected verbatim into `passthrough`.
2. **Global flags.** Before a verb has been fixed, any `-`/`--`-prefixed token must be a *global* flag (table in §4.5); unknown flags here are a usage error (exit 2). Note: a lone `-` is a positional (the "last ref" shorthand), not a flag.
3. **Positional 0 (`p0`):**
   - If `p0` ∈ top-level verbs → dispatch top-level; remaining tokens go to that verb's parser.
   - Else if `p0` matches `^https?://` or `^git@` → **URL form**: find the project whose `repo` matches the URL's host+owner+repo (normalize `.git` suffix, ssh↔https). Zero matches → error `E_RESOLVE` listing configured repos. If the URL encodes a ref (`/pull/<n>` → PR ref; `/tree/<branch>` → branch ref), consume it as the ref; otherwise the next positional is the ref.
   - Else → `p0` must name a project (`<p0>.toml` exists in the config dir). If not, exit 3 with the list of known projects (and a nearest-name suggestion if edit distance ≤ 2).
4. **Positional 1 (`p1`):**
   - Absent → treat as `list` (i.e. bare `testlane n8n` ≡ `testlane n8n list`).
   - If `p1` ∈ project verbs → project command; remaining tokens are its args/flags.
   - Else → `p1` is the **ref** (parsed per §6).
5. **Positional 2 (`p2`):**
   - Absent → use the project's `default_command` (config; default `"code"`).
   - If `p2` ∈ workspace verbs → that verb; remaining tokens are its args/flags.
   - Else if `p2` matches a key of the project's `[commands.*]` table → sugar for `run <p2>`. Built-in verbs always win this collision; `doctor` warns when a configured command name shadows a built-in.
   - Else → exit 2: `unknown command '<p2>' — did you mean 'run <p2>'? configured commands: dev, test, …`.
6. **Verb-local flags.** Once the verb is fixed, all remaining pre-`--` tokens (flags and positionals) are handed to that verb's own parser. Unknown verb-local flags are exit 2.

### 4.4 Examples (canonical — these must all work)

```
testlane n8n 19234                     # PR 19234 → default_command (code)
testlane n8n 19234 code
testlane n8n pr/19234 run dev
testlane n8n '#19234' shell
testlane n8n ai/fix-canvas-drag checkout
testlane n8n ai/fix-canvas-drag dev    # sugar → run dev
testlane n8n - run test                # last-used ref for n8n
testlane n8n ~/agents/wt-3 run test    # adopt existing directory
testlane https://github.com/n8n-io/n8n/pull/19234 code
testlane https://github.com/n8n-io/n8n/tree/ai/fix-canvas-drag diff
testlane n8n 19234 exec -- pnpm why lodash
testlane n8n 19234 run dev -- --host 0.0.0.0  # passthrough appended to command argv
testlane n8n list --json
testlane n8n clean --merged --older-than 14d --yes
testlane n8n 19234 sync --fresh
testlane projects
testlane doctor
testlane config edit n8n
cd "$(testlane n8n 19234 checkout)"    # works because of the stdout contract (§13)
```

### 4.5 Global flags

Recognized anywhere before the verb; also accepted after it (verb parsers must tolerate them):

| Flag | Effect |
|---|---|
| `--config-dir <path>` | Override config directory (highest precedence). |
| `--dry-run` | Print external commands instead of executing; no state writes. §13.4 |
| `--json` | Machine-readable stdout where supported (`checkout`, `list`, `info`, `start`, `ps`, `projects`, `doctor`). Elsewhere: exit 2. Setup and hook output goes to stderr while it's set. |
| `--quiet`, `-q` | Suppress step logging on stderr (errors still print). |
| `--verbose`, `-v` | Log every external command with timing to stderr. |
| `--yes`, `-y` | Skip confirmation prompts (required for destructive ops when stdin is not a TTY). |
| `--no-color` | Disable ANSI colors (also honors `NO_COLOR` env and non-TTY stderr). |

Ref disambiguators (workspace commands only): `--pr <n>`, `--branch <name>`, `--path <p>` force the ref interpretation and replace the positional ref (e.g. `testlane n8n --branch 1234 code` for a branch literally named `1234`).

---

## 5. Configuration

### 5.1 Discovery

Config directory resolution order: `--config-dir` flag → `TESTLANE_CONFIG_DIR` env → `~/.testlane` (default). Testlane 2.x also falls back to the 1.x variable and directory, with a warning (§5.6). If the directory does not exist, every command except `help`/`version`/`doctor`/`completions`/`setup`/`mcp`/bare `config`/`config path` and `config add <url>` fails with exit 3 and a hint to create it.

### 5.2 Layout

```
<config-dir>/
  defaults.toml          # optional global defaults
  n8n.toml               # one file per project; filename = project name
  styleframe.toml
  seeds/
    n8n/                 # seed file tree for project "n8n" (§8.4)
      .env.local
      packages/cli/.env
```

Project names must match `^[a-z0-9][a-z0-9._-]*$` (the filename without `.toml`). `defaults` and `seeds` are reserved names.

### 5.3 `defaults.toml`

```toml
root = "~/dev/testlane"   # base dir for derived repo_path / worktrees_path
editor = "zed"            # fallback editor preset or template
default_command = "code"  # fallback default verb
```

All keys optional. `env` and `commands` are **not** allowed in defaults (keep per-project config self-contained).

### 5.4 Project file — full schema

Annotated example (`n8n.toml`):

```toml
# ── Repository ────────────────────────────────────────────────
repo = "git@github.com:n8n-io/n8n.git"       # required. ssh or https.
repo_path = "~/dev/testlane/n8n/repo"        # optional. default: {root}/{project}/repo
worktrees_path = "~/dev/testlane/n8n/trees"  # optional. default: {root}/{project}/trees
default_branch = "master"                    # optional. default: auto-detect from origin HEAD

# ── Behavior ──────────────────────────────────────────────────
editor = "zed"                               # optional. preset name or template (§10)
default_command = "code"                     # optional. verb or configured command name
ports = 1                                    # optional. contiguous ports per workspace, 1–10
base_port = 5700                             # optional. default: 3000 + (fnv1a32(project) % 40) * 100

# ── Setup (runs after checkout, before run/exec/shell) ────────
[setup]
run = "pnpm install --frozen-lockfile"       # optional. bash -c string
cache_key = ["pnpm-lock.yaml", "**/package.json"]  # globs, relative to worktree
seed_files = [".env.local", "packages/cli/.env"]   # relative paths to seed (§8.4)
seed_from = "~/dev/n8n"                      # optional extra seed source (§8.4)

# ── Environment for run/exec/shell/hooks (templated, §5.5) ────
[env]
N8N_PORT = "{port}"
N8N_USER_FOLDER = "{data_dir}"
VITE_BASE_URL = "http://localhost:{port}"

# ── Named commands ────────────────────────────────────────────
[commands.dev]
run = "pnpm dev"                             # required. bash -c string, templated
cwd = "packages/frontend/editor-ui"          # optional, relative to worktree root
[commands.dev.env]                           # optional, overrides [env]
NODE_OPTIONS = "--max-old-space-size=8192"

[commands.test]
run = "pnpm test"

# ── Hooks (§12) ───────────────────────────────────────────────
[hooks]
post_checkout = "echo 'workspace ready: {path}'"
# pre_run = "..."
# post_sync = "..."
# pre_clean = "..."
```

Field reference:

| Key | Type | Required | Default | Notes |
|---|---|---|---|---|
| `repo` | string | **yes** | — | Clone URL. Used for URL-form project inference. |
| `repo_path` | path | no | `{root}/{project}/repo` | Error if neither this nor `defaults.root` is set. |
| `worktrees_path` | path | no | `{root}/{project}/trees` | Same rule. Must not be inside `repo_path`. |
| `default_branch` | string | no | auto-detect | `git ls-remote --symref origin HEAD` at init; cached in state. |
| `editor` | string | no | defaults → `"code"` | §10. |
| `default_command` | string | no | defaults → `"code"` | Validated against verbs + command names at load. |
| `ports` | int 1–10 | no | 1 | Contiguous block size. |
| `base_port` | int 1024–65000 | no | derived | See example above; keeps projects apart deterministically. |
| `setup.run` | string | no | — | Skipped entirely when absent. |
| `setup.cache_key` | string[] | no | `[]` | Empty ⇒ setup runs once per workspace (hash of empty set). |
| `setup.seed_files` | string[] | no | `[]` | Relative paths, no `..` segments. |
| `setup.seed_from` | path | no | — | Directory; second-priority seed source. |
| `env` | table<string,string> | no | `{}` | Values templated. |
| `commands.<name>` | table | no | — | `name` matches `^[a-z0-9][a-z0-9:_-]*$`. `run` required. |
| `hooks.*` | string | no | — | Only the four names in §12. |

Path values support leading `~` expansion only (no env-var interpolation). Validation is aggregate: report *all* schema errors for a file at once, each as `n8n.toml: commands.dev.run: expected string, got number`, then exit 3.

### 5.5 Template variables

Interpolated (single pass, `{name}` syntax, unknown name ⇒ error `E_CONFIG` at use time) in: `[env]` values, `commands.*.run`, `commands.*.cwd`, `hooks.*`, and editor templates. `{{` escapes a literal `{`.

| Variable | Value |
|---|---|
| `{path}` | Absolute worktree path |
| `{repo_path}` | Absolute primary-repo path |
| `{data_dir}` | Per-workspace data dir (§8.3) |
| `{project}` | Project name |
| `{ref}` | Original ref string as typed |
| `{branch}` | Resolved local branch name (or short SHA for detached) |
| `{slug}` | Workspace slug |
| `{port}` | First allocated port |
| `{port+N}` | `port + N`, valid for `N < ports` (literal digits, e.g. `{port+1}`) |

The same values are always exported to child processes as `TESTLANE_PATH`, `TESTLANE_REPO_PATH`, `TESTLANE_DATA_DIR`, `TESTLANE_PROJECT`, `TESTLANE_REF`, `TESTLANE_BRANCH`, `TESTLANE_SLUG`, `TESTLANE_PORT`, `TESTLANE_PORT_1`…`TESTLANE_PORT_{ports-1}` (§11.2), whether or not the config references them.

### 5.6 Compatibility with uxd

Testlane was called uxd until 2.0. For the 2.x line it still reads what uxd wrote, so a user can upgrade the package first and move their files later. All of it lives in `src/lib/compat.ts`, the only module that names uxd, so 3.0 removes the fallbacks by deleting that file and its tests.

| What | Resolution order |
|---|---|
| Config dir | `--config-dir` → `$TESTLANE_CONFIG_DIR` → `$UXD_CONFIG_DIR` (warns) → `~/.testlane` if it exists → `~/.uxd` if it exists (warns) → `~/.testlane` |
| State dir | `<state>/testlane` if it exists → `<state>/uxd` if it exists (warns) → `<state>/testlane`, where `<state>` is `${XDG_STATE_HOME:-~/.local/state}` |
| Debug | `TESTLANE_DEBUG=1` → `UXD_DEBUG=1` (warns), read only when `TESTLANE_DEBUG` is unset or empty |
| Exported | every `TESTLANE_*` variable (§5.5), then its `UXD_*` twin with the same value, in layer 2 of §11.2 |

- **Warnings.** Each fallback prints one line on stderr, `warning: using <old>, the <what> of uxd. Testlane 3.0 reads only <new>.` and the fix, like `mv ~/.uxd ~/.testlane`. A run prints each warning at most once (`main()` resets them), however often it resolves the path. They never reach stdout, so the stdout contracts and `--json` hold.
- **Both present.** The new name wins and nothing warns. A set `TESTLANE_DEBUG`, even `0`, wins over `UXD_DEBUG`.
- **No migration.** Testlane never moves the user's files. `setup` on a machine with neither config dir creates `~/.testlane`.
- **No `uxd` binary.** The package ships only `testlane`, because a second bin named `uxd` would clash with an installed `@uxfront/uxd`.
- **Exported twins don't warn.** Testlane can't see which process reads `$UXD_PORT`, so the aliases are silent. Layers 3–5 of §11.2 override either name.

### 5.7 Repository config (`.testlane.toml`)

A repo can commit a `.testlane.toml` at its root, so its maintainers write the setup, env and commands once and every user gets them. It holds the keys that describe the repo, never the user's machine.

| Allowed | User-only (rejected in the repo file) |
|---|---|
| `ports`, `default_command`, `[setup]` `run`/`cache_key`/`seed_files`, `[env]`, `[commands.*]`, `[hooks]` | `repo`, `repo_path`, `worktrees_path`, `default_branch`, `editor`, `base_port`, `setup.seed_from` |

Validation is aggregate, as in §5.4, and every issue names the file as `<project>:.testlane.toml`, for example `app:.testlane.toml: editor: user-only key; set it in app.toml`.

**Where it is read.** Only from the tip of the default branch in the primary repo: the blob at `refs/remotes/origin/<default>:.testlane.toml`. Never from a worktree, and never from the ref being materialized, so a PR (same-repo or fork) cannot change what `setup`, `hooks` or `commands` run on the reviewer's machine. The default branch is the user's `default_branch`, else the bare clone's `HEAD` (origin's default at clone time), else `git ls-remote --symref origin HEAD`. Testlane adds no fetch for it: it reads the tracking ref the run's own fetches left, so an upstream change is seen by the first run that fetches the default branch (first clone, a checkout or `--fetch` of it, or `config trust`). The file must be a regular file of at most 1 MiB, in UTF-8.

**Trust.** A repo file's commands run only after the user approves that exact content.

- The approval is stored in project state as `repoConfig` (§8.2): the sha256 of the file's bytes, its git blob id, the content itself and `approvedAt`.
- The config a run uses is always the user file plus the **last approved snapshot**. Unapproved content never reaches it.
- The gate (§8.1) compares the tip's blob id with the stored one, so an unchanged file needs no blob read and no network. When they differ, it reads and validates the tip (a schema error fails the run with exit 3; it does not fall back), then shows what it would run: on first use, `setup.run`, each `commands.<name>.run` with its `cwd`, each hook, then the whole file; on a change, a unified diff from the approved content. Then it asks `Trust <project>:.testlane.toml? [y/N]` on stderr.
- `--yes` approves without asking. With stdin not a TTY and no `--yes`, the run fails with `E_CONFIG`: `<project>:.testlane.toml is not trusted` (first use) or `<project>:.testlane.toml changed since you trusted it`, both with `hint: testlane config trust <project>`.
- Declining on first use runs the user file on its own. Declining a change keeps the version approved before.
- A stored approval that no longer matches its sha256 or no longer validates (a hand-edited state file, or a schema change) counts as none: commands that only read config use the user file alone, the gate asks again as on first use, and `config validate` and `doctor` report it.
- Every value, file and diff the gate shows has its control characters (C0, C1, DEL) and bidi controls escaped, like `\r` or `\u001b`, so the file can't repaint or reorder the lines you approve from. The same goes for each issue the repo file's validation reports, TOML parse errors included, since they quote the file before anything is approved.
- A file removed upstream drops the stored approval, with one `→` line.
- Repo commands are known at parse time only once approved. Until then, `testlane app dev` reads `dev` as a ref, and `testlane app 12 dev` fails with `E_USAGE` (unknown command). Run `config add <url>` or `config trust <project>` first. `run`/`start` check the command again after the gate, and an approved change that drops it is `E_USAGE`.

**Merge.** The user file wins.

| Keys | Rule |
|---|---|
| Scalars (`ports`, `default_command`, `setup.run`) | The user value replaces the repo value. |
| Arrays (`setup.cache_key`, `setup.seed_files`) | The user value replaces the repo value; never concatenated. |
| `[env]` | Merged by key. |
| `[commands]` | Merged by name; a user command replaces the whole repo command, `cwd` and `env` included. |
| `[hooks]` | Merged per hook name. |

Precedence for a key is: the user file, then the repo file, then `defaults.toml`, then the built-in default. Only `default_command` exists in both the repo file and `defaults.toml`, so a repo `default_command` beats the user's `defaults.toml` one. A project without a repo file behaves exactly as before.

A user `default_command` may name a repo command. Until that file is approved, the project fails to load with `E_CONFIG` and `hint: testlane config trust <project>`. `config trust` leaves that check to the file it approves: it records the file only if the user file merged with it validates, and otherwise fails with `E_CONFIG` and every issue.

---

## 6. Ref resolution

### 6.1 Input → RefSpec

Parsed in this order (first match wins). Disambiguator flags (`--pr`, `--branch`, `--path`) bypass the table. `--branch` still refuses a name that row 6 would refuse with `E_RESOLVE`, so git can never read it as an option or a refspec.

| # | Pattern | RefSpec | Example |
|---|---|---|---|
| 1 | `-` | last-used ref for this project (from state; error `E_RESOLVE` if none) | `testlane n8n - shell` |
| 2 | starts with `/`, `./`, `../`, or `~` | `{ kind: "path", path }` | `~/agents/wt-3` |
| 3 | `^#?\\d+$` | `{ kind: "pr", number }` | `19234`, `#19234` |
| 4 | `^pr/(\\d+)$` (case-insensitive) | `{ kind: "pr", number }` | `pr/19234` |
| 5 | `^[0-9a-f]{40}$` | `{ kind: "commit", sha }` (M2) | full SHA |
| 6 | anything else valid per `git check-ref-format --branch`, not starting with `-` or `+`, and not `head` in any case | `{ kind: "branch", name }` | `ai/fix-canvas-drag` |
| 7 | otherwise | exit 4, `E_RESOLVE` with the failed pattern | — |

Notes: short SHAs are deliberately *not* auto-detected (ambiguous with hex-ish branch names) — commit refs require the full 40 chars or a future `--commit` flag. URL-form refs are extracted during classification (§4.3) and produce `pr` or `branch` RefSpecs.

```ts
type RefSpec =
  | { kind: "pr"; number: number }
  | { kind: "branch"; name: string }
  | { kind: "commit"; sha: string }        // M2
  | { kind: "path"; path: string }         // adopted
  | { kind: "last" };                      // resolved to one of the above before use
```

### 6.2 Resolution to a git target

- `pr` → fetch `refs/pull/<n>/head` (§7.3); local branch `pr/<n>`.
- `branch` → fetch `origin/<name>`; local branch `<name>`.
- `commit` → ensure object present (fetch if needed); detached worktree.
- `path` → no git resolution; directory must exist and `git -C <path> rev-parse --git-dir` must succeed, else exit 4.

### 6.3 Slugs

`slug(refSpec)`:

- `pr` → `pr-<number>`
- `branch` → sanitize name: replace `[^A-Za-z0-9._-]` with `-`, collapse consecutive `-`, trim leading/trailing `-`/`.`, lowercase. If result exceeds 60 chars, truncate to 52 and append `-` + first 7 hex of sha256 of the full name. If sanitization collides with an existing workspace for a *different* ref, append the hash suffix unconditionally.
- `commit` → `sha-<first 10 of sha>`
- `path` → `adopted-` + sanitized basename + `-` + first 7 hex of sha256 of the absolute path.

Worktree directory = `<worktrees_path>/<slug>`. Slug is also the state key.

---

## 7. Git layer

All git interaction shells out to the `git` binary (min version **2.38**) with argv arrays — never through a shell, never via libgit2 bindings. Every repo-level invocation uses `git -C <repo_path> …`. Set `GIT_TERMINAL_PROMPT=0` on non-interactive operations so auth failures error instead of hanging.

### 7.1 Primary repo initialization (first use of a project)

```bash
git clone --bare --filter=blob:none <repo> <repo_path>
git -C <repo_path> config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git -C <repo_path> config fetch.prune true
git -C <repo_path> config push.default upstream
git -C <repo_path> fetch origin --no-tags
```

Rationale, in order: bare clones don't set a fetch refspec (classic gotcha — without it, `origin/<branch>` tracking refs never materialize); pruning keeps agent-branch churn from accumulating; `push.default upstream` makes plain `git push` from a `pr/<n>` branch push to the *differently named* agent branch it tracks (the user's global `push.default simple` would refuse the name mismatch). `--filter=blob:none` keeps the clone cheap on a large monorepo; blobs stream in lazily at worktree checkout.

Default branch detection: `git ls-remote --symref origin HEAD` → cache in state as `defaultBranch` unless config overrides.

### 7.2 Worktree creation

Branch ref:

```bash
git -C <repo_path> fetch --no-tags origin --end-of-options +refs/heads/<name>:refs/remotes/origin/<name>
git -C <repo_path> worktree add <worktrees_path>/<slug> -B <name> --track origin/<name>
```

On a filesystem that ignores case (git sets `core.ignorecase` there), `refs/remotes/origin/Main` is the same file as `refs/remotes/origin/main`. So a name that differs from an existing `origin/*` ref only in case or Unicode normalization is refused with `E_RESOLVE` before the fetch.

If the branch is already checked out in another Testlane worktree, git refuses; catch that error and re-point the user at the existing workspace path (this is the dedupe path — normally the slug lookup in state short-circuits earlier).

PR ref (same-repo and fork alike for the read path):

```bash
git -C <repo_path> fetch origin '+refs/pull/<n>/head:refs/heads/pr/<n>' --no-tags
git -C <repo_path> worktree add <worktrees_path>/<slug> pr/<n>
```

The leading `+` forces the update — agents force-push constantly and a non-forced fetch would fail on rewritten history.

Commit ref (M2): `git worktree add --detach <dir> <sha>`.

### 7.3 PR push-back wiring

After creating a PR workspace, attempt (best-effort; degrade with a single warning if `gh` is missing or unauthenticated):

```
gh pr view <n> --repo <owner/name> --json headRefName,isCrossRepository,headRepositoryOwner,state,title,author,url
```

- **Same-repo PR** (`isCrossRepository: false`) — the common agent case:
  ```bash
  git -C <repo_path> config branch.pr/<n>.remote origin
  git -C <repo_path> config branch.pr/<n>.merge refs/heads/<headRefName>
  ```
  Combined with `push.default upstream`, a plain `git push` (and `git pull`) inside the worktree now targets the agent's actual branch — you can commit a review fix and hand it straight back.
- **Fork PR** (`isCrossRepository: true`, M2): `git remote add fork-<owner> <fork clone url>` (reuse if present), fetch the head branch, set the local branch's upstream to it. Without `gh`, fork PRs are read-only: warn `push-back unavailable for fork PRs without gh`.

Cache the returned PR metadata in state (`pr.title`, `pr.author`, `pr.state`, `pr.url`, `pr.headRefName`, `pr.fetchedAt`) for `list`/`info`; refresh opportunistically on `sync` and on `list` when `gh` responds within 2s (parallel, non-blocking — stale-while-revalidate).

### 7.4 `sync` algorithm

1. Re-fetch per §7.2 for the workspace's kind (forced for PRs).
2. Determine target: `@{u}` if upstream configured, else the just-fetched `refs/heads/pr/<n>`.
3. If the worktree is dirty (`git status --porcelain=v2` non-empty):
   - default → exit 5 listing dirty paths, hint: `--stash` or `--discard`.
   - `--stash` → `git stash push --include-untracked -m "testlane sync <timestamp>"`, continue, and print the stash ref.
   - `--discard` → `git reset --hard && git clean -fd`, continue.
4. `git reset --hard <target>` (worktrees are disposable; merge/rebase preservation is a non-goal).
5. Run `post_sync` hook. Invalidate nothing else — setup cache re-checks hashes naturally on next `run`.
6. `--fresh` replaces steps 2–5 with: `rm` the workspace (§9.9 single-target path, honoring dirty checks unless `--discard`), then re-materialize.

### 7.5 Removal

Per workspace: run `pre_clean` hook → `git -C <repo_path> worktree remove <dir>` (add `--force` only when the plan explicitly includes a dirty workspace and the user passed `--force`) → delete local branch (`git branch -D pr/<n>` always for PR branches; for plain branches only with `--force`, since the branch may be the user's) → delete `<worktrees_path>/.data/<slug>` → drop state entry → `git worktree prune`. Adopted workspaces: state entry and data dir only — never touch the directory or any branch; skipped by `clean` filters unless `--include-adopted`.

### 7.6 Locking

All state-mutating operations (init, fetch+worktree add, sync, clean/rm, state writes) take a per-project lock: create `${XDG_STATE_HOME:-~/.local/state}/testlane/<project>.lock` exclusively (`O_CREAT|O_EXCL`), write `{"pid":…,"startedAt":…}`. On contention: if the holder pid is dead, steal and warn; if alive, wait up to 30s polling at 250ms, then exit 5 with the holder's pid. Release in a `finally`. Read-only commands (`list`, `info`, `projects`, `diff`) skip the lock.

---

## 8. Workspace lifecycle & state

### 8.1 `ensureWorkspace` (the pipeline)

```
ensureWorkspace(project, refSpec, opts { setup: boolean }):
  1. lock(project)
  2. resolve refSpec (§6) → slug
  3. state = loadState(project)
  4. if state.workspaces[slug] exists and its path exists on disk:
       ws = it                                     # fast path — no network
       (--fetch) re-fetch
       trust gate (§5.7)                           # on every call, with or without --fetch
     else:
       ensure primary repo initialized (§7.1)
       fetch the ref (§7.2)
       trust gate (§5.7)                           # before anything is created
       worktree add (§7.2, §7.3)
       allocate port block (§8.5); create data dir
       ws = new entry; run post_checkout hook
  5. if opts.setup: runSetup(ws)                    # §8.4 — seeds + install, cached
  6. ws.lastUsedAt = now; state.lastRef = original ref string; save state
  7. unlock; return ws
```

The trust gate runs under the lock, after the run's fetch and before any worktree add, `post_checkout` or setup. It settles the project's config in place and writes an approval into the state held by this pipeline, saving it at once, so every hook, setup and command after it uses the approved snapshot, and a refused gate leaves no new workspace behind. It is skipped for an adopted path when the primary repo isn't initialized, and in `--dry-run`.

`checkout`/`code`/`diff`/`info` call it with `setup: false`; `run`/`exec`/`shell` with `setup: true` (`--no-setup` overrides; `--setup` forces it for checkout/code). A `--fetch` flag on any workspace verb forces step 4's fetch even on the fast path (i.e. an inline sync, minus reset).

### 8.2 State file

`${XDG_STATE_HOME:-~/.local/state}/testlane/<project>.json`, schema-versioned, written atomically (temp file + rename):

```jsonc
{
  "version": 1,
  "defaultBranch": "master",
  "lastRef": "19234",
  "workspaces": {
    "pr-19234": {
      "slug": "pr-19234",
      "ref": "19234",                       // as originally typed
      "kind": "pr", "number": 19234,
      "branch": "pr/19234",
      "path": "/home/alex/dev/testlane/n8n/trees/pr-19234",
      "adopted": false,
      "ports": [5701],
      "createdAt": "2026-07-21T09:12:00Z",
      "lastUsedAt": "2026-07-21T10:40:00Z",
      "setupHash": "a1b2c3…",               // sha256 over cache_key files (§8.4)
      "pr": { "title": "fix(editor): canvas drag", "author": "agent-bot",
              "state": "OPEN", "url": "…", "headRefName": "ai/fix-canvas-drag",
              "fetchedAt": "2026-07-21T10:40:00Z" }
    }
  }
}
```

`repoConfig` (optional) holds the approved `.testlane.toml` snapshot (§5.7):

```jsonc
"repoConfig": {
  "sha256": "9f2c…",                       // of the file's bytes
  "blob": "3b18e512dba79e4c8300dd08aeb37f8e728b8dad",  // git blob id at approval
  "content": "[commands.dev]\nrun = \"pnpm dev\"\n",
  "approvedAt": "2026-11-13T10:40:00Z"
}
```

It needs no version bump: older 2.x releases keep the field when they rewrite the file. Commands that read only config (`projects`, `config show`, `config validate`, URL routing, parse-time command lookup) read this field leniently: a missing, corrupt or newer-version state file means "no snapshot".

Unknown `version` → exit 3 with an upgrade hint. Entries whose `path` no longer exists are reported by `list` as `missing` and swept by `clean --prune-state`.

### 8.3 Data directories

`<worktrees_path>/.data/<slug>/`, created at materialization, exported as `{data_dir}`/`TESTLANE_DATA_DIR`. Purpose: per-workspace mutable state (SQLite files, user folders, caches) so concurrent instances never share; e.g. `N8N_USER_FOLDER = "{data_dir}"`. Lives beside the worktrees (not inside them — keeps `git status` clean) and dies with the workspace.

Testlane keeps three files of its own there for `start` (§9.14): `process.json`, the record of the one detached process (`pid`, its `lstart` start time as `ps -o lstart=` prints it, `command`, `port`, `log`, `startedAt`), `process.log`, which that process's stdout and stderr are appended to, and `start.lock`, held while a `start` runs. `stop` removes `process.json` and keeps the log.

### 8.4 Setup: seeding + install, cached

`runSetup(ws)`:

1. **Seed.** For each entry in `setup.seed_files` (validated: relative, no `..`): if `<worktree>/<rel>` already exists, skip (never overwrite). Otherwise copy from the first source that has it: `<config-dir>/seeds/<project>/<rel>` → `setup.seed_from/<rel>`. Neither has it → warn once, continue. `--reseed` deletes the targets first.
2. **Hash.** Expand `setup.cache_key` globs (via `tinyglobby`, sorted, relative to worktree; excluded: anything under `node_modules/` or `.git/`); `setupHash = sha256(concat(relpath, "\\0", file bytes, "\\0") …)`.
3. **Install.** If `setup.run` is set and `setupHash !== ws.setupHash`: run it (`bash -c`, cwd = worktree, env = composed env §11.2, stdio inherited). Success → persist new hash. Failure → exit 6 and leave the old hash so the next attempt retries.
4. `pre_run` hook, when the caller is `run`/`exec`/`shell`/`start`.

### 8.5 Port allocation

Deterministic-first within the project's window `[base_port, base_port + 100 * ports)`: candidate = `base_port + (fnv1a32(slug) % 100) * ports`. Probe each port in the block by binding a TCP listener on `127.0.0.1` and closing it; on conflict (bind failure or overlap with another workspace's recorded block in state), linearly scan upward in `ports`-sized strides within the window. Note the derived `base_port` spaces projects 100 apart, which exactly fits the default `ports = 1` window; a project that raises `ports` should set an explicit `base_port` (doctor warns when derived windows overlap). Persist the block in state so a workspace keeps its ports for life (re-probe on each `run`; if now occupied by an unrelated process, warn and continue — the workspace's own detached leftovers are the common cause and reallocation would break config that memorized the port).


---

## 9. Command specifications

Common behavior for all workspace verbs: run `ensureWorkspace` first; honor `--fetch`, `--setup`/`--no-setup`, ref disambiguators, and global flags; human/step output to stderr, primary result to stdout (§13).

### 9.1 `checkout`

```
testlane <project> <ref> checkout [--fetch] [--setup] [--json]
```

Materialize only. **stdout: the absolute worktree path, one line, nothing else** — this is a stable contract (`cd "$(testlane n8n 19234 checkout)"`). `--json`: `{ "project", "slug", "ref", "kind", "branch", "path", "ports", "created": bool }`. Exit 0 on success (whether created or reused).

### 9.2 `code`

```
testlane <project> <ref> code [--editor <preset|template>] [--fetch]
```

Materialize, then launch the editor (§10). GUI editors: spawn detached, don't wait, exit 0 immediately. Terminal editors (`wait: true` presets): inherit stdio, propagate exit code. stdout: nothing (path is logged to stderr).

### 9.3 `run <name>`

```
testlane <project> <ref> run <name> [--port <n>] [--env K=V ...] [--no-setup] [-- extra args]
```

Materialize + setup, then execute `commands.<name>`: template `run`, execute via `bash -c` with cwd = worktree (+ command `cwd`), env per §11.2, stdio fully inherited. Passthrough args are appended to the command line, shell-escaped, separated by a space (i.e. `bash -c '<run> "$@"' testlane <extra…>` — implement exactly this so quoting is safe). `--port` overrides the block's first port for this invocation (env + templates see the override; state unchanged). Unknown `<name>` → exit 2 listing configured commands. Testlane's exit code = child's exit code (129+signal on signal death); SIGINT/SIGTERM are forwarded to the child's process group and Testlane waits for it to exit.

### 9.4 `exec`

```
testlane <project> <ref> exec [--no-setup] -- <argv...>
```

Same environment/cwd as `run`, but the passthrough argv is spawned **directly, no shell**. Missing `--` or empty argv → exit 2. Exit code propagation identical to `run`.

### 9.5 `shell`

```
testlane <project> <ref> shell [--no-setup]
```

Spawn `$SHELL` (fallback `bash`), interactive, cwd = worktree, env per §11.2. Print one stderr banner first: `testlane: <project>/<slug> — port <p> — <path>`. Exit code = shell's.

### 9.6 `sync`

```
testlane <project> <ref> sync [--stash | --discard | --fresh]
```

Per §7.4. stdout: nothing. stderr summarizes: old SHA → new SHA, files changed count, stash ref if created.

### 9.7 `diff`

```
testlane <project> <ref> diff [--stat] [--tool] [-- git-diff args]
```

PR workspaces with `gh` available: delegate to `gh pr diff <n>` (respects PR base). Otherwise: `git -C <ws> diff <merge-base>...HEAD` where merge-base = `git merge-base origin/<defaultBranch> HEAD`, passing through `--stat` and post-`--` args. Pager: inherit stdio and let git/gh page normally.

### 9.8 `list` / `info`

```
testlane <project> list [--json]
testlane <project> <ref> info [--json]
```

`list` human output — aligned columns to stdout, one row per workspace, sorted by `lastUsedAt` desc:

```
SLUG          KIND    BRANCH               STATUS   PORT   AGE   LAST USED   TITLE
pr-19234      pr      ai/fix-canvas-drag   open ✓   5701   2d    1h          fix(editor): canvas drag
ai-refactor   branch  ai/refactor-store    dirty    5711   9d    3d          —
adopted-wt-3  path    (adopted)            clean    5721   1d    1d          —
```

`STATUS`: for PRs, `pr.state` lowercased + ` ✓`/` ✗` for CI pass/fail when `gh` metadata is fresh; plus `dirty` when the worktree has uncommitted changes; `missing` when `path` is gone. Computing `dirty` runs `git status --porcelain` per workspace — acceptable at these counts. `--json`: array of the full state entries plus computed `dirty`/`missing`/`diskBytes` (`diskBytes` only with `--du`, it's slow). `info` prints the same for a single workspace (human form: key-value lines).

### 9.9 `clean` / `rm`

```
testlane <project> clean [--merged] [--closed] [--older-than <Nd|Nh>] [--all]
                    [--include-adopted] [--prune-state] [--force] [--yes]
testlane <project> <ref> rm [--force] [--yes]
```

Filters OR together; no filter and no `--all` → exit 2. `--merged`/`--closed` use cached/refreshed PR state when available, else fall back to `git branch --merged origin/<defaultBranch>`. Always print the plan first (slug, reason, dirty?, disk size), then confirm (TTY prompt, or require `--yes`). Dirty workspaces are skipped with a warning unless `--force`. Then remove per §7.5. `rm` is `clean` targeting exactly one workspace. stdout after completion: one line per removed slug (machine-usable); stderr: freed disk total.

### 9.10 `projects`

stdout table: `NAME  REPO  WORKSPACES  PATH-EXISTS`. `--json` supported.

### 9.11 `doctor`

Runs the checks below; each prints `ok` / `warn` / `fail` + one-line detail to stdout. Exit 0 if no `fail`, else 1. `--json` supported.

| Check | Fail/warn condition |
|---|---|
| git version | fail < 2.38 |
| gh present + `gh auth status` | warn if missing/unauthed (feature-degrade list) |
| config dir exists & readable | fail |
| each project config schema-valid | fail, per file |
| `repo_path` parent writable / repo healthy (`git rev-parse --is-bare-repository`) | fail |
| bare repo fetch refspec configured (§7.1) | fail with the exact `git config` fix |
| editor binary resolvable (PATH lookup, or in place when the preset yields a path such as `$SHELL`) | warn |
| state dir writable; state files parse | fail |
| stale lock files | warn (with steal hint) |
| orphaned worktrees (`git worktree list` entries missing from state, tracked entries git no longer knows, and tracked entries whose directory is gone from disk — git does not auto-prune, so the disk check is what catches a hand-`rm -rf`) | warn, hint `clean --prune-state` |
| configured command name shadows a built-in verb | warn |
| repo `core.hooksPath` set to a path outside the repo / husky installed | warn (hooks may misbehave in worktrees) |
| `project <name>: repo file` (§5.7), comparing blob ids only, so offline | ok: no file, trusted, or not cloned yet; warn: untrusted, changed since approval, or removed upstream with an approval stored; fail: the stored approval no longer matches its sha256 or no longer validates |

### 9.12 `config`

`config path` → print config dir (stdout). `config edit [project]` (alias `config add [project]`) → open `<project>.toml` (or the dir) in `$EDITOR`/project editor. `config validate [project]` → run schema validation for one/all projects, including each approved repo-config snapshot (§5.7), report per §5.4, exit 3 on any error.

`config add <url> [--name <name>] [--root <dir>]` adds a project from its repo. The argument is any URL `testlane` routes (§4.3): ssh, https, or a `/pull/<n>` or `/tree/<branch>` web URL.

- The project name is the repo name, and `--name` overrides it. An invalid name is `E_USAGE`.
- It writes `<name>.toml` with one line, `repo = "<clone url>"`: an ssh URL verbatim, or `https://<host>/<owner>/<repo>.git` with the original case.
- It needs `defaults.root`. On a new machine, `--root <dir>` creates the config dir and writes `root` to `defaults.toml`, as `setup` does, so `config add <url>` is exempt from the config-dir guard (§5.1). Without either, it fails with `E_CONFIG` and `hint: pass --root <dir>, for example --root ~/dev/testlane`. A `--root` that differs from an existing `defaults.root` is `E_USAGE`.
- An existing `<name>.toml` or `repo_path` is `E_CONFIG`. Every check runs before anything is written.
- It then clones the primary repo (§7.1). A failed clone puts back what the run wrote (the project file, and the config dir, `root` line and root directory it created) and exits 5.
- A state file left by an earlier project of the same name loses its approval, saved before the trust prompt, so it never vouches for this repo, even when the run then stops at the prompt.
- With a `.testlane.toml` on the default branch, it shows it and asks for trust (§5.7). Off a TTY without `--yes`, the project stays and the run exits 3 with `hint: testlane config trust <name>`. Without a repo file, it writes the §9.12 template with the real `repo` line and opens the editor, as `config add <name>` does.
- `--dry-run` prints the files it would write and the clone commands, and touches nothing.

`config trust <project>` → under the lock, clone the primary repo if needed, fetch the default branch, then show the repo file (first use) or the diff from the approved one, ask, and record the approval. When there is nothing to approve, it reports "already trusted" or "no .testlane.toml on origin/<default>" as a `→` step line (silenced by `--quiet`) and exits 0. A stored approval that no longer matches its sha256 or no longer validates counts as none, so `config trust` shows the file and asks again as on first use. Off a TTY without `--yes`, it exits 3 with `hint: re-run on a terminal, or pass --yes`. It loads the user file alone, so a broken snapshot never stops it.

`config show <project>` → the merged config, offline, one `key = value  # source` line per key, where the source is `user`, `repo` or `default` (`defaults.toml` and built-in defaults). `--json` prints one object: `{ project, approved: { sha256, approvedAt } | null, config, sources }`, where `config` uses TOML key names and `sources` maps a dotted key (`commands.dev`, `env.PORT`, `setup.run`) to its source.

### 9.13 `completions <bash|zsh|fish>` (M2)

Static script completing: top-level verbs, project names (reads config dir), project/workspace verbs, configured command names and workspace slugs via `testlane <project> list --json`.

### 9.14 `start <name>`

```
testlane <project> <ref> start <name> [--timeout <seconds>] [--env K=V ...] [--no-setup] [--reseed] [--fetch] [-- extra args]
```

Runs `commands.<name>` in the background, so an agent or a script can hand back a running app. Materialize + setup + `pre_run`, then build the command exactly as `run` does (§9.3, same `bash -c '<run> "$@"' testlane <extra…>` and env), and spawn it with `detach` (§11.1): its own session and process group, stdout and stderr appended to `<data_dir>/process.log`.

Record `<data_dir>/process.json` (§8.3) before waiting, so an interrupted `start` can still be stopped. Then poll `127.0.0.1:{port}` until it accepts a TCP connection, and return. The rules:

- **One process per workspace.** A *live* entry is one whose PID answers `kill(pid, 0)` and whose `ps -o lstart=` equals the recorded `lstart`, so a PID the OS has reused is not live. `start`, `stop` and `ps` share this one test. When the entry is live with the same command, print it with `reused: true` and run nothing (no setup, no hooks, no process). When a different command is live, exit 2 and name the running command and the `stop` to run. A dead entry is replaced.
- **Concurrency.** An exclusive `<data_dir>/start.lock` (created `wx`, stolen from a dead holder as §7.6 does) serializes starts of one workspace without holding the project lock through the readiness wait. A second `start` waits on it for its own `--timeout`, not §7.6's 30 seconds, then sees the first one's live entry and prints it. Timing out on the lock exits 5.
- **Readiness.** `--timeout` defaults to 300 seconds. When the child exits first, kill what's left of its group, clear the entry, print the last 20 log lines to stderr and exit 6. When the port isn't ready in time, stop the group (§9.15), clear the entry and exit 6 with a hint to bind `127.0.0.1:{port}`. When something already accepts on the port before the spawn, exit 6 without spawning, since readiness would be meaningless.
- **No `--port`.** It's a usage error (exit 2), so the entry's port always equals `{port}` and hooks see the same one. `--dry-run` prints the env and command as `run` does and spawns nothing.

stdout: the URL `http://127.0.0.1:<port>`. `--json`: one object with `project`, `slug`, `command`, `pid`, `port`, `url`, `log`, `startedAt` and `reused`.

### 9.15 `stop`

```
testlane <project> <ref> stop
```

When the entry is live (§9.14), send SIGTERM to its process group (`kill(-pid)`), so children of the shell (a `vite` under `bash -c`) die too. Wait up to 10 seconds for the group to empty, then SIGKILL it. Remove `process.json` and keep the log.

A dead or reused PID is never signalled: the entry is cleared and `stop` exits 0. With no entry, print "not running" and exit 0. `rm` and `clean` (§9.9) do the same for each workspace they remove, after `pre_clean` ran and didn't veto, and before anything is deleted.

### 9.16 `logs`

```
testlane <project> <ref> logs [-f | --follow]
```

Print `<data_dir>/process.log` to stdout. With `-f`, keep printing new lines until SIGINT/SIGTERM, starting over when the file shrinks. No log → exit 2 with a message.

### 9.17 `ps`

```
testlane <project> ps [--json]
```

One row per `process.json` found in the project's workspaces (the state's slugs plus every directory under `<worktrees_path>/.data`): `SLUG  COMMAND  PID  PORT  STATUS  STARTED  LOG`, sorted by slug, where `STATUS` is `running` for a live entry (§9.14) and `exited` otherwise. `--json`: an array of `{ slug, command, pid, port, status, startedAt, log }`.

### 9.18 `mcp`

```
testlane [--config-dir <dir>] mcp
```

`testlane mcp` serves Testlane to an MCP client over stdio, so an agent gets typed tools instead of parsing the CLI's output. [ADR-003](docs/adrs/003-mcp-server.md) is the decision and the full contract. In short:

- **Protocol.** A hand-written JSON-RPC 2.0 server, one message per line: `initialize`, `ping`, `tools/list` and `tools/call`, plus the `initialized`, `progress` and `cancelled` notifications. It speaks protocol versions `2025-11-25`, `2025-06-18`, `2025-03-26` and `2024-11-05`, and declares only the `tools` capability. It takes no arguments (exit 2 with any).
- **Tools.** `projects`, `doctor`, `config_validate`, `list`, `ps`, `info`, `diff`, `logs`, `checkout`, `start`, `stop` and `rm`. Each calls its verb's function in-process with `--json` and `--yes` set, and returns the verb's `--json` line as one text block. `stop`, `logs`, `diff` and `rm` have no `--json`, so they return `{exitCode, stdout, stderr}`. `logs` returns the last `lines` lines (default 100, at most 1000) and never follows. `diff` keeps 1 MiB and adds `truncated: true` past that. `rm` adds `removed`, and a kept workspace is `isError: true`. A thrown error is `{error: {errCode, exitCode, message, hint}, stderr}` with `isError: true`.
- **stdout carries only protocol messages.** Each call prints into a buffer of its own, setup and hook output goes to stderr, children get a closed stdin and their own process group, and any other write to stdout is sent to stderr.
- **Progress and timeouts.** `checkout` and `start` send `notifications/progress` for each step and a heartbeat at least every 5 seconds when the call carries a `progressToken`. They take `timeout` in seconds (default 600). When it runs out, or a `notifications/cancelled` arrives, the server stops what the call started (2 seconds' grace, then SIGKILL) and answers `timedOut: true`, or nothing for a cancel.
- **Config.** The config dir is fixed when the server starts, and each call reads its files afresh. The server starts without a config dir, and each tool but `doctor` then fails with `E_CONFIG`. It never records trust in a repo config.

A project named `mcp` can only be reached by its URL form, since the verb shadows it.

---

## 10. Editors

`editor` config is either a **preset name** or a **custom template** (any string containing `{path}`).

| Preset | Launch | wait |
|---|---|---|
| `zed` | `zed {path}` | no |
| `code` | `code --new-window {path}` | no |
| `cursor` | `cursor --new-window {path}` | no |
| `windsurf` | `windsurf {path}` | no |
| `idea` / `webstorm` / `phpstorm` / `goland` | `<name> {path}` (JetBrains launcher scripts) | no |
| `vim` / `nvim` / `helix` / `hx` | `<name> {path}` | **yes** |
| `terminal` | spawn `$SHELL` interactive, cwd `{path}` | **yes** |

Custom templates run via `bash -c` with `{path}` substituted **shell-escaped**; `wait` defaults to `no` (append `:wait` to the template, e.g. `"my-editor {path} :wait"`, to flip it). `no-wait` launches are detached (new session, stdio ignored) so Testlane exits immediately.

---

## 11. Process execution & environment

### 11.1 `lib/proc.ts` contract

Exactly two spawn modes, both argv-based on `node:child_process`. Note: Node
reports a missing executable as an async `error` event (ENOENT), not a sync
throw, so `capture`/passthrough map that to the setup/external error contract
below rather than relying on a synchronous failure:

- `capture(argv, { cwd, env }): { code, stdout, stderr }` — for git/gh plumbing. Non-zero exit throws `TestlaneError(E_GIT | E_EXTERNAL)` carrying trimmed stderr; callers that expect failure pass `{ allowFailure: true }`.
- `passthrough(argv, { cwd, env, detach? }): exitCode` — stdio inherited (or detached per §10); used by run/exec/shell/editor/hooks/setup. Installs SIGINT/SIGTERM forwarding to the child process group for the duration.
- `detach(argv, { cwd, env, log? }): { pid, exited }` is the detached half of `passthrough`, which `passthrough({ detach: true })` calls. The child gets a new session and process group (its PGID is its PID) and is unref'd so Testlane can exit. stdio is ignored, or appended to `log`. `exited` settles with the exit code, so `start` notices a child that dies before its port is ready.

Config-supplied *strings* (`setup.run`, `commands.*.run`, `hooks.*`, custom editor templates) always execute as `["bash", "-c", string]` — documented trust model: config is user-authored code on the user's machine; Testlane does not sandbox it. Internal operations never string-concatenate shell commands.

### 11.2 Environment composition (later wins)

1. `process.env` (Testlane inherits the caller's PATH — nvm/fnm shims included);
2. computed `TESTLANE_*` vars (§5.5), then their 1.x twins (§5.6);
3. project `[env]` (templated);
4. `commands.<name>.env` (templated);
5. `--env K=V` flags.

`--dry-run` prints layers 2–5 as `export` lines before the command.

---

## 12. Hooks

Four hooks, all optional strings run via `bash -c`, cwd = worktree, env = §11.2, stdio inherited:

| Hook | When | Non-zero exit ⇒ |
|---|---|---|
| `post_checkout` | after a workspace is first materialized | operation fails (exit 6), workspace kept (retry on next use — hook idempotency is the config author's job) |
| `pre_run` | after setup, before `run`/`exec`/`shell`/`start` command | operation aborts (exit 6) |
| `post_sync` | after a successful sync reset | warn only |
| `pre_clean` | before each workspace removal | that workspace is skipped, warn |

---

## 13. Output & UX conventions

1. **stdout is for results, stderr is for humans.** Step logs, progress, warnings, confirmations → stderr. The machine-usable result (a path, a table, JSON, removed slugs) → stdout. This must hold for every command so substitution and piping never break.
2. **`--json`** replaces stdout with a single JSON document (object or array). Never mix human text into JSON stdout.
3. **Logging levels.** Default: one `→`-prefixed stderr line per significant step (`→ fetching pull/19234`, `→ worktree ready (reused)`). `--verbose` adds every external command with duration. `--quiet` silences all stderr except warnings/errors. Colors only when stderr is a TTY, minus `NO_COLOR`/`--no-color`.
4. **`--dry-run`** prints, to stdout, the external commands that would run (one per line, shell-quoted) plus `mkdir`/`cp`/`rm` lines for filesystem mutations; performs no writes, takes no locks, and skips confirmations. Read-only introspection (loading config/state) still happens.
5. **Errors**: single stderr block — `error(E_CODE): message`, optional `hint: …` second line. No stack traces except with `--verbose` or `TESTLANE_DEBUG=1`.
6. **No spinners, no animation.** Line-oriented output only; Testlane will be invoked by other automation and read in logs.

---

## 14. Errors & exit codes

| Code | Const | Meaning |
|---|---|---|
| 0 | — | success |
| 1 | `E_INTERNAL` | unexpected internal failure |
| 2 | `E_USAGE` | argv/flag/verb errors |
| 3 | `E_CONFIG` | config dir/schema/template/state-version errors |
| 4 | `E_RESOLVE` | ref didn't parse or doesn't exist remotely; unknown URL project |
| 5 | `E_GIT` | git/gh operation failed; dirty-tree refusal; lock timeout |
| 6 | `E_SETUP` | setup command or blocking hook failed |
| child's | — | `run`/`exec`/`shell`/waiting editors propagate the child's exit code verbatim (may collide with the table above; documented and accepted) |

`TestlaneError { code: ExitCode; errCode: string; message: string; hint?: string }` is the only error type `main.ts` formats; anything else is `E_INTERNAL`.


---

## 15. Architecture

### 15.1 Repository layout

```
testlane/
  package.json            # "bin": { "testlane": "./dist/bin/testlane.js" }, scripts: dev/test/build (tsc)
  bin/testlane.ts         # source entry → imports src/main.ts; compiled to dist/bin/testlane.js (#!/usr/bin/env node)
  tsconfig.json           # strict: true, noUncheckedIndexedAccess: true
  DESIGN.md               # this file
  src/
    main.ts               # entry: parse → dispatch → top-level TestlaneError formatting
    cli/
      parse.ts            # tokenizer + classification algorithm (§4.3)
      help.ts             # usage text per verb
    config/
      schema.ts           # zod schemas + inferred types (Config, ProjectConfig, …)
      load.ts             # discovery (§5.1), TOML parse, defaults merge, aggregate errors
      repo.ts             # .testlane.toml parse/validate and the user-over-repo merge (§5.7)
    core/
      resolve.ts          # ref → RefSpec (§6.1), slug(), URL extraction
      workspace.ts        # ensureWorkspace pipeline (§8.1)
      setup.ts            # seeding, cache-key hashing, install (§8.4)
      ports.ts            # allocation (§8.5)
      state.ts            # load/save (atomic), lock/unlock (§7.6)
      trust.ts            # the repo-config trust gate (§5.7)
      supervise.ts        # process.json, liveness, stop, readiness (§9.14–9.17)
    git/
      repo.ts             # init, fetch strategies, default-branch detect (§7.1–7.3)
      worktree.ts         # add/remove/prune/status/dirty (§7.2, §7.5)
      gh.ts               # GhClient interface + real impl; graceful absence
    commands/             # one file per verb, each: (ctx, args) => Promise<exitCode>
      checkout.ts code.ts run.ts exec.ts shell.ts sync.ts diff.ts
      info.ts list.ts clean.ts projects.ts doctor.ts config.ts completions.ts
      lifecycle.ts        # start/stop/logs/ps (§9.14–9.17)
    lib/
      proc.ts             # capture/passthrough/detach (§11.1)
      log.ts              # stderr steps, levels, color gating
      template.ts         # {var} interpolation (§5.5)
      paths.ts            # ~ expansion, XDG dirs
      compat.ts           # 1.x fallbacks and warnings (§5.6)
      errors.ts           # TestlaneError, exit codes (§14)
  test/
    unit/                 # parse, resolve, slug, template, ports, schema
    integration/          # real-git scenarios (§17)
    fixtures.ts           # makeFixtureRepo() etc.
```

### 15.2 Key types (implement verbatim in `schema.ts` / neighbors)

```ts
interface Ctx {                       // built once in main.ts, threaded everywhere
  configDir: string;
  defaults: Defaults;
  flags: GlobalFlags;                 // dryRun, json, quiet, verbose, yes, …
  log: Logger;
  gh: GhClient;                       // injectable for tests
}

interface ProjectConfig {
  name: string;
  repo: string;
  repoPath: string;                   // resolved, absolute
  worktreesPath: string;              // resolved, absolute
  defaultBranch?: string;
  editor: string;
  defaultCommand: string;
  ports: number;
  basePort: number;
  setup: { run?: string; cacheKey: string[]; seedFiles: string[]; seedFrom?: string };
  env: Record<string, string>;
  commands: Record<string, { run: string; cwd?: string; env: Record<string, string> }>;
  hooks: Partial<Record<"post_checkout" | "pre_run" | "post_sync" | "pre_clean", string>>;
}

interface Workspace {                 // state entry, §8.2
  slug: string; ref: string;
  kind: "pr" | "branch" | "commit" | "path";
  number?: number; branch?: string;
  path: string; adopted: boolean;
  ports: number[];
  createdAt: string; lastUsedAt: string;
  setupHash?: string;
  pr?: { title: string; author: string; state: string; url: string;
         headRefName: string; fetchedAt: string };
}

interface GhClient {                  // git/gh.ts
  available(): Promise<boolean>;
  prView(repo: string, n: number): Promise<PrMeta | null>;   // null on any failure
  prDiff(repo: string, n: number): Promise<number>;          // passthrough, returns exit code
}
```

### 15.3 Data flow

```
argv ─▶ cli/parse ─▶ config/load ─▶ commands/<verb>
                                       │
                                       ▼
                          core/workspace.ensureWorkspace
                          ├─ core/resolve       (RefSpec, slug)
                          ├─ core/state         (lock, load, save)
                          ├─ git/repo,worktree  (fetch, add)  ── lib/proc
                          ├─ core/ports
                          └─ core/setup         (seed, hash, install)
                                       │
                                       ▼
                          act: editor / proc.passthrough / git diff / …
```

---

## 16. Technology choices

| Concern | Choice | Rationale |
|---|---|---|
| Runtime | **Node ≥ 18** (TypeScript compiled to JS via `tsc`; the published bin is `dist/bin/testlane.js`) | universal availability with no Bun prerequisite; Node stdlib (`node:child_process`, `node:net`, `fs/promises`) plus `tinyglobby` cover proc/glob/fs needs. Superseded the original Bun runtime — see **ADR-002**. |
| CLI parsing | **hand-rolled** (§4.3) over `node:util` `parseArgs` tokens | the grammar is positional and context-dependent (dynamic project names, freeform refs, verb-position rules); frameworks fight this. ~150 lines, table-driven tests. See ADR-001. |
| TOML | `smol-toml` | small, spec-complete, typed. |
| Validation | `zod` | schema + inferred types + good error paths for §5.4's aggregate reporting. |
| Colors | `picocolors` | tiny; no chalk. |
| Glob | `tinyglobby` | Node has no built-in glob at the ≥18 floor (`fs.glob` is Node ≥22); replaces the former `Bun.Glob`. |
| Everything else | stdlib (Node built-ins) | no execa (proc.ts is a thin layer on `node:child_process`), no table dep (pad columns manually), no libgit2. |

Runtime dependency budget: those **four** packages (`smol-toml`, `zod`, `picocolors`, `tinyglobby`). Treat additions as design changes (see ADR-001's amendment clause; the `tinyglobby` addition was authorized by ADR-002).

> **Note (ADR-002, 2026-07-22):** the runtime moved from Bun to compiled Node.
> The standalone `bun build --compile` single-file binary was dropped (Node's
> SEA has no clean parity — deferred). The npm bin is the sole install path.

---

## 17. Testing strategy

Runner: `vitest` (was `bun test`; see ADR-002). `gh` is never invoked in tests — `GhClient` is injected (`fakeGh(fixtures)` / `unavailableGh`).

### 17.1 Unit (pure, fast)

- `cli/parse`: table-driven over §4.4's canonical examples + error cases (unknown verb, flag-before-verb, `--` handling, `-` positional).
- `core/resolve`: §6.1 table incl. URL extraction; slug sanitization/truncation/collision.
- `lib/template`: all vars, `{port+N}` bounds, unknown-var error, `{{` escape.
- `core/ports`: determinism, stride math, conflict scan (probe fn injected).
- `config`: valid fixture parses to expected `ProjectConfig`; each invalid fixture yields its aggregate error strings; defaults merge and derived paths.

### 17.2 Integration (real git, tmp dirs)

`fixtures.ts` provides:

```ts
makeFixtureOrigin(tmp): {
  url: string;              // file:// bare repo acting as origin
  commit(branch, files): sha;
  makePr(n, branch): void;  // git update-ref refs/pull/<n>/head <sha> in origin
  forcePush(branch, files): sha;
}
makeEnv(tmp, projects): { configDir, stateHome, run(argv): {code, stdout, stderr} }
// run() invokes main() in-process with TESTLANE_CONFIG_DIR/XDG_STATE_HOME pointed at tmp
```

Scenarios (each asserts exit code, stdout contract, stderr contains, and on-disk git state):

1. first `checkout` of a branch — clones bare, sets fetch refspec, worktree exists, stdout = path.
2. second `checkout` — no fetch (assert via injected proc recorder), same path, exit 0.
3. `checkout` of a PR ref — `pr/<n>` branch, worktree, state entry.
4. `sync` after `forcePush` — hard reset to new sha; dirty tree → exit 5; `--stash` path keeps changes in a stash; `--fresh` recreates.
5. `run` with `setup.run = "echo install >> log"` — runs once; second `run` skips (hash cache); editing a `cache_key` file re-runs.
6. seeding — file lands from seeds dir; never overwrites; `--reseed` does.
7. `clean --merged` — merge PR branch into default in origin, fetch, plan includes it, removal drops worktree+branch+data+state; adopted workspace untouched.
8. adopt path ref — commands run there; `rm` leaves the directory.
9. env composition — `run` of `env`-dumping command shows §11.2 precedence, `TESTLANE_PORT` set.
10. `--dry-run checkout` on a fresh project — prints clone/fetch/worktree commands, creates nothing.
11. lock contention — two concurrent `checkout`s serialize (second waits), stale lock with dead pid is stolen.
12. `list --json` shape; `doctor` on a corrupted repo (deleted fetch refspec) fails with the fix hint.
13. `start`, `stop`, `logs` and `ps` (`test/integration/lifecycle.test.ts`): a `node` server on `$TESTLANE_PORT` outlives `main()`, repeat and concurrent starts leave one process, an early exit and a timeout exit 6, `stop` kills a `bash -c` tree and never signals a reused PID, and `rm` stops the process before it removes anything. Each test kills what it started.

---

## 18. Milestones & acceptance criteria

### M0 — usable in one evening

- [ ] parse (§4.3), config load + `config validate` (§5), errors/exit codes (§14), stdout/stderr contract (§13)
- [ ] primary repo init (§7.1), branch + same-repo PR checkout (§7.2), push-back wiring when `gh` present (§7.3)
- [ ] `checkout`, `code` (presets: zed/code/cursor/terminal), `list` (no PR metadata columns), `rm`, `clean` with explicit slugs + `--all`, `projects`, `doctor` (git/gh/config/repo checks), `--dry-run`
- [ ] state file + locking
- **Accept:** every §4.4 example that doesn't involve `run`/`exec`/`shell`/`sync`/`diff`/sugar works against the fixture origin; integration scenarios 1–3, 10, 11 pass.

### M1 — the daily driver

- [ ] setup pipeline: seeding, cache-key hashing, install (§8.4); data dirs; port allocation + `{port}`/`TESTLANE_*` env (§8.5, §11.2)
- [ ] `run` (+ passthrough, `--port`, `--env`), `exec`, `shell`, command-name sugar, `default_command`, `-` ref
- [ ] `sync` (`--stash`/`--discard`/`--fresh`), `clean --older-than/--merged` (git-only fallback), hooks (§12)
- **Accept:** three concurrent `testlane n8n <ref> run dev` instances serve on distinct ports with distinct data dirs; scenarios 4–9 pass.

### M2 — polish & ecosystem

- [ ] `gh` metadata in `list`/`info` (stale-while-revalidate), fork-PR push-back, `diff`, `info --json`/`list --json` finalized, `clean --closed --prune-state`
- [ ] URL-form invocation, commit refs, adopted-workspace edge cases, `completions`, remaining `doctor` checks (§9.11), interactive picker on bare `testlane <project>` when TTY (fallback: `list`)
- **Accept:** scenario 12; completions demo in zsh; fork-PR flow manually verified against a real GitHub fork.

### M3 — deferred (do not build now)

`watch`, restarting or reaping detached processes, per-workspace service orchestration, reflink `node_modules` acceleration, brew/npm distribution.

---

## 19. Implementation gotchas (read before coding)

1. **Bare clones have no fetch refspec.** Without §7.1's `config remote.origin.fetch`, `origin/*` tracking refs never appear and `--track` fails. `doctor` checks this because users will hand-create repos.
2. **Force-fetch PR refs** (`+refs/pull/…`). Agents rewrite history; a plain fetch fails on non-fast-forward and the error is cryptic.
3. **`push.default upstream` is set in the shared bare repo config** — it applies to all worktrees of that repo. That's intended (the repo is Testlane-owned), but never write it to a user's own repo (adopted workspaces are untouched).
4. **`.git` in a worktree is a file**, not a directory — it points at `<repo>/worktrees/<name>`. Tools that assume a `.git` dir (some Docker volume setups, old scripts) break; nothing for Testlane to fix, but `doctor`'s husky/hooksPath warning and README should mention it.
5. **`core.hooksPath` + husky**: repos that set relative hook paths can resolve them wrong from worktrees; also `pnpm install` may try to install hooks into the bare repo. Warn, don't fix.
6. **Partial clone needs network for new blobs.** First checkout of a worktree and `diff` across unfetched trees will lazily fetch. Offline mode is degraded by design; error messages should say "network required (partial clone)".
7. **Branch already checked out** in another worktree → git refuses `worktree add`. Catch and point at the existing workspace.
8. **Manual `rm -rf` of a worktree dir** leaves git metadata behind; run `git worktree prune` during `clean` and flag orphans in `doctor`.
9. **Atomic state writes** (temp + rename) and the project lock prevent two Testlane invocations from corrupting state — n8n workflows *will* fire Testlane concurrently.
10. **Spawn argv arrays everywhere** except the documented `bash -c` cases; paths contain spaces.
11. **pnpm in worktrees** is fine — the global content-addressable store means per-worktree `node_modules` are mostly hardlinks; still, surface disk usage in `clean` because dozens of workspaces add up.
12. **`git worktree remove` refuses dirty trees** without `--force` — the plan/confirm flow in §9.9 depends on that; don't pre-force.
13. **Signal handling in `run`**: spawn the child in its own process group and forward signals to the group, or dev-server child trees (vite + esbuild workers) survive Ctrl-C.
14. **Name check**: before publishing anywhere, verify `testlane` is free on npm/brew; the binary name is otherwise an easy rename (single constant).

---

## Appendix A — sample session

```
$ testlane n8n 19234 run dev
→ resolving pr/19234
→ cloning n8n (bare, partial) into ~/dev/testlane/n8n/repo  # first use only
→ fetching pull/19234 → pr/19234
→ worktree ready: ~/dev/testlane/n8n/trees/pr-19234
→ push-back wired to origin/ai/fix-canvas-drag
→ seeded .env.local, packages/cli/.env
→ setup: pnpm install --frozen-lockfile (cache miss)
→ running dev on port 5701  (Ctrl-C to stop)
… vite output …
^C
$ testlane n8n 19234 code
→ worktree ready (reused)
→ opening in zed
$ testlane n8n list
SLUG       KIND  BRANCH               STATUS   PORT   AGE  LAST USED  TITLE
pr-19234   pr    ai/fix-canvas-drag   open ✓   5701   5m   just now   fix(editor): canvas drag
$ testlane n8n clean --merged --yes   # …a week later
→ plan: pr-19234 (merged, clean, 1.9 GB)
pr-19234
→ freed 1.9 GB
```

## Appendix B — minimal second project config

```toml
# styleframe.toml — shows how small a config can be with defaults.toml root set
repo = "git@github.com:alexgrozav/styleframe.git"
editor = "code"

[setup]
run = "pnpm install"
cache_key = ["pnpm-lock.yaml"]

[commands.dev]
run = "pnpm dev --port {port}"

[commands.test]
run = "pnpm test"
```