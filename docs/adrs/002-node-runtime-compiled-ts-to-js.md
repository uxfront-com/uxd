# ADR-002: Run on stock Node via a compiled TS→JS bin; Bun runtime dropped
Date: 2026-07-22 · Status: Accepted
Deciders: Tech lead ruling (UXF-39 thread, 2026-07-22) · Operator (alex) informed, veto window open, not exercised
Informed by: UXF-39 (user request), signal's Bun-surface audit
Supersedes: — · Superseded by: —
Reverses: DESIGN.md §16 runtime choice · Amends: ADR-001 (dependency budget only — parsing decision unaffected)

## Context

DESIGN.md §16 fixed the runtime as **Bun ≥ 1.1** and stated plainly that
**"Node compatibility is a non-goal."** The rationale at the time: iteration
speed on a personal tool, with `Bun.spawn` / `Bun.Glob` / `Bun.file` covering
proc/glob/fs, and `bun build --compile` available for a single-file binary if
the tool spread to the team. That non-goal held through M0–M2.

UXF-39 reversed the premise: the tool is meant to be **universally available**
without the user having Bun installed. That is a direct contradiction of the
§16 non-goal, so the runtime decision had to be re-made, not worked around.

signal audited every Bun-specific surface (verified, `uxd@0.0.0`) and mapped
each to a Node equivalent — `Bun.spawn` → `node:child_process`, `Bun.listen`
TCP probe → `node:net`, `Bun.Glob`/`Bun.file` → `tinyglobby` + `fs/promises`,
`Bun.which` → PATH scan, `import.meta.dir` → `import.meta.dirname` /
`fileURLToPath`, `bun:test` → vitest. No enums/namespaces/decorators and
imports already carried `.ts` extensions, so both a "compile to JS" and a
"ship TS, native type-stripping" path were technically open.

Two live options were surfaced for how the bin runs on Node:

- **A) Compile TS→JS** — ship `dist/bin/uxd.js`, `#!/usr/bin/env node`,
  `engines.node >=18`. Adds a build step; `bin`/`files` point at compiled
  output. **Steelman:** widest install floor (every current LTS incl. Node 20),
  least surprise, no dependence on young runtime features. Chosen.
- **B) Ship `.ts`, native type-stripping** — no build step,
  `#!/usr/bin/env node`, but `engines.node >=22.18`. **Steelman:** zero build
  step, closest to the old no-build-in-dev ergonomics. Rejected: a Node 22.18
  floor strands Node 20 LTS users, defeating "universally available"; type
  stripping is still young.

Separately, `bun build --compile` (single-file standalone binary) has **no
clean Node twin** — SEA is experimental and clunky.

## Decision

We will run `uxd` on **stock Node ≥ 18** via **strategy A**: TypeScript is
compiled to JavaScript (`tsc`, `rewriteRelativeImportExtensions` emitting `.js`
specifiers), the published bin is `dist/bin/uxd.js` with `#!/usr/bin/env node`,
and every Bun API is replaced by its Node equivalent. `bun:test` is replaced by
**vitest**. The standalone `bun build --compile` binary is **dropped from
scope**; the npm bin is the sole install path and **SEA is deferred**. Adopting
`tinyglobby` as the glob replacement is an authorized addition to ADR-001's
dependency budget (three → four runtime packages), made per ADR-001's own
"additions require a decision" clause.

## Consequences

Good: `uxd` installs and runs on every current Node LTS with no Bun
prerequisite — the "universally available" goal is met at the widest floor;
the migration held parity (133/133 green on Node v24.18.0 at land time); the
build step is internal and reversible.

Bad: there is now a build step between source and a runnable bin — a `git pull`
requires a rebuild where `bun link` updated source in place (documented in the
README install delta, PR #10); the runtime dependency surface grew by one
package (`tinyglobby`); **no standalone single-file binary ships** — users
without Node cannot run a prebuilt binary until/unless SEA is scoped; Node's
async-only primitives forced internal shims (spawn ENOENT is an async `error`
event, not a sync throw; the TCP port probe went async), which are more code
than their Bun one-liners.

Neutral: `tsc` becomes the build tool; the test runner is vitest instead of
`bun test`; `@types/node` replaces `bun-types`/`@types/bun`.

## Revisit triggers

Reopen (new ADR superseding this one) if any of:

- A **standalone single-file binary** becomes a hard distribution requirement —
  scope SEA (or a bundler-based single-file build) as a follow-up; this ADR
  deferred it, it did not rule it out permanently; or
- Node's native TypeScript type-stripping reaches a stable floor at or below the
  supported LTS minimum, making the compile step (strategy A's main cost)
  removable without stranding users (reopening the A-vs-B call); or
- The build step or the compiled-`dist` install model proves to cost more in
  contributor friction or release breakage than the Bun runtime it replaced.
