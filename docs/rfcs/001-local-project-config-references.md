# RFC-001: Local project config references (`extends`)

Status: Accepted · Date: 2026-07-24
Author: signal
Issue: UXF-40
Deciders: Operator (alex) — "Approved: Option A" (UXF-40 thread, 2026-07-24)
Reversibility: two-way door (additive, opt-in, no change to existing files)

## Problem

Today a uxd project is a single `<name>.toml` in the config dir
(`--config-dir` → `$UXD_CONFIG_DIR` → `~/.uxd`; DESIGN.md §5.1). The project
name *is* the filename, discovery lists `*.toml`, and load merges the file over
`defaults.toml` (`src/config/load.ts`). All configuration lives outside the
repository it describes.

Users want to **commit** a uxd config inside their repo (shared `setup`,
`commands`, `ports`, `hooks`) and have the central config dir **reference** it,
so the repo owns the shared truth and teammates don't hand-copy TOML.

## Constraints

- **Name-addressing must survive.** uxd is invoked `uxd <project> <ref> <cmd>`
  from anywhere; worktrees, ports, and state are keyed centrally by project
  name. A design that only works from inside the repo (CWD-scoped) breaks the
  core model.
- **The reference resolves at load time.** A project's `repo_path` may not be
  cloned yet, and worktrees are throwaway. The referenced file must live at a
  stable path (the user's own clone), never inside a materialized worktree.
- **Config is executable.** `setup.run`, `hooks.*`, and `commands.*.run` are
  bash strings. Any mechanism that *auto-loads* discovered config turns
  "clone a repo + run uxd" into arbitrary code execution. Loading must be
  explicit and opt-in.

## Decision

Add an optional `extends` key to a project file. The config-dir file is a thin
**pointer**; the referenced repo-committed file is the **base**; the pointer's
own keys **override** the base. Precedence, lowest to highest:

```
defaults.toml  <  extends base (repo-committed)  <  local pointer file
```

This keeps discovery and name-addressing untouched, stays explicit/opt-in (you
add the pointer yourself), and gives an honest override layer so machine-specific
paths and secrets stay local and out of the repo.

### Example

`~/.uxd/n8n.toml` (local pointer, machine-specific bits + secrets):

```toml
extends = "~/dev/n8n/.uxd.toml"   # stable clone, not a worktree
repo_path = "~/dev/uxd/n8n/repo"  # local override
[env]
N8N_LICENSE_KEY = "..."           # secret stays local
```

`~/dev/n8n/.uxd.toml` (committed in the repo, shared truth):

```toml
repo = "git@github.com:n8n-io/n8n.git"
ports = 2
[setup]
run = "pnpm install --frozen-lockfile"
[commands.dev]
run = "pnpm dev"
```

### Merge rules

- **Scalars** (`repo`, `editor`, `ports`, …): local replaces base.
- **Tables** (`env`, `commands`, `hooks`, `setup`, and nested `commands.<name>`):
  merged key-by-key; local wins per key.
- **Arrays** (`setup.seed_files`, `setup.cache_key`): local **replaces** base
  wholesale (predictable > clever; no positional surprises).

The merged result is then validated by the existing strict schema and runs
through the same path/port derivation, so every current rule (required `repo`,
`worktrees_path` not inside `repo_path`, `seed_files` no `..`, etc.) still
applies to the effective config.

### Boundaries

- **Single level.** The referenced base file may **not** itself set `extends`.
  Attempting it is a config error. This caps complexity and makes cycles
  impossible; a self-reference is also rejected explicitly.
- **Resolution.** `extends` is a filesystem path resolved with `~` expansion,
  relative paths anchored to the **config dir**. It is not interpolated.
- **Errors** (all `E_CONFIG`, exit 3, aggregated and labeled with the offending
  file): referenced file missing/unreadable, TOML parse error in the base,
  base contains `extends`, self-reference.

### Tooling

- `uxd config link <name> --from <path>` scaffolds a pointer file that `extends`
  the given path, then validates it.
- `config edit`, `config validate`, and `projects` inherit the behavior for free
  because they all resolve through `loadProject`.

## Options considered

**A — `extends` pointer file (chosen).** Explicit, opt-in, discovery/name-model
untouched, honest override layer. Cost: one manual pointer per project; new
merge semantics to pin down (done above).

**B — Registered source roots + auto-discovery.** `defaults.toml` lists
directories; uxd scans them for `*.uxd.toml` and auto-registers. Rejected:
auto-loading discovered, executable config is a supply-chain hazard, and it
complicates name resolution and collisions.

**C — Ambient `.uxd.toml` from CWD.** Load the repo's config when run inside it.
Rejected: breaks name-from-anywhere invocation and central worktree/port keying,
same untrusted-exec risk, largest model change for the least fit.

**Zero-code baseline (symlink `~/.uxd/n8n.toml` → repo file).** Works with
today's loader unchanged but offers no override layer, has Windows symlink
friction, and makes `config edit` mutate the repo file. Fine as a stopgap, not
the design.

## Consequences

**Good:** repos own shared config; secrets/machine-paths stay local; no change
to existing single-file setups; explicit opt-in preserves the security boundary.

**Bad / watch:** a second file to keep in sync per linked project; a stale or
moved `extends` target yields a load error until fixed (clear message, but still
a failure mode); merge semantics are new surface users must learn.

## Non-goals

- Multi-level / chained `extends` (single level only for now).
- Auto-discovery of repo configs (explicitly rejected on security grounds).
- Array-merge concatenation (arrays replace).
- Pulling config over the network or from a git ref that isn't checked out.
