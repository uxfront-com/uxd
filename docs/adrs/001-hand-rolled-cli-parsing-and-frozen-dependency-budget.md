# ADR-001: Hand-rolled CLI parsing and a frozen three-package dependency budget
Date: 2026-07-21 · Status: Accepted
Deciders: Operator (alex) · Informed by: DESIGN.md §16, UXF-34 M0 review
Supersedes: — · Superseded by: —
Amended by: ADR-002 (dependency budget three → four: `tinyglobby` added for the Node glob replacement; the hand-rolled-parsing decision is unaffected)

## Context

`uxd` is a Bun CLI whose argument grammar is positional and context-dependent
(§4.3): project names are dynamic, refs are freeform, and the verb can appear in
more than one position. DESIGN.md §16 fixed the technology choices for the tool
up front, and M0 (UXF-34) was built against them: a ~150-line hand-rolled parser
over `node:util` `parseArgs` tokens, `proc.ts` as ~60 lines on `Bun.spawn` (no
`execa`), manual column padding (no table dependency), and a runtime dependency
budget of exactly three packages — `smol-toml`, `zod`, `picocolors`.

M0 shipped and was verified green (90 tests passing, both S3 error-contract nits
fixed, PR #1 merged). During review the question was raised whether a CLI
framework (e.g. `citty`) should replace the hand-rolled parser. That inverts
§16's premise: §16 does not omit a framework by oversight — it rejects
frameworks by name, on the rationale that "frameworks fight" a positional,
context-dependent grammar. The Operator was asked to either hold §16 as written
or authorize a timeboxed RFC to revisit the dependency policy. No new
evidence had surfaced to invalidate the original constraints. The Operator chose
to hold. This ADR back-fills the record so the decision is not re-litigated
blind.

The live options at the decision point:

- **Adopt a CLI framework** (citty / commander / yargs). Steelman: less
  bespoke parsing code to maintain; conventional help/usage generation; a
  familiar API for future contributors. This is a real, defensible option for
  most CLIs.
- **Keep the hand-rolled parser** (chosen). The grammar's positional,
  verb-position-flexible shape is exactly what framework command trees model
  poorly, so a framework would still need custom glue to handle §4.3 — trading
  ~150 tested lines for a dependency plus adapter code, with no functional gain.

## Decision

We will keep CLI argument parsing hand-rolled over `node:util` `parseArgs`
tokens, and hold the runtime dependency budget at exactly three packages
(`smol-toml`, `zod`, `picocolors`); any addition is treated as a design change
requiring its own decision.

## Consequences

Good: no dependency fights the §4.3 grammar; the parser stays ~150 lines with
table-driven tests fully under our control; the dependency surface (supply
chain, install time, audit burden) stays minimal; M0's proven, tested code is
preserved rather than churned for parity.

Bad: parsing, process spawning, and table formatting are ours to maintain and
document — new contributors meet bespoke code instead of a framework they may
already know; there is no framework-provided help/usage scaffolding, so those
conventions must be built and kept consistent by hand.

Neutral: `parseArgs` remains the tokenizer beneath the hand-rolled layer, so we
are not parsing raw `argv` from zero.

## Revisit triggers

Reopen this decision (new ADR, superseding this one) if any of:

- The §4.3 grammar is deliberately simplified to a shape a standard framework
  command tree models cleanly (fixed verb position, no freeform positional
  refs), removing the "frameworks fight this" rationale; or
- The hand-rolled parser exceeds ~2× its budgeted size (~300 lines) or its
  table-driven tests stop being able to characterize its behavior; or
- A candidate framework is shown, measured against the actual §4.3 grammar, to
  handle it with less total code than the hand-rolled parser plus its glue.
