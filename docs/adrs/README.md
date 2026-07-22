# Architecture Decision Records

Records of decisions that were actually made — the context, the call, and the
consequences we accepted — so the same lesson isn't paid for twice. ADRs are
append-only: to change a decision, add a new ADR that supersedes the old one;
never edit an accepted ADR's substance.

| # | Title | Date | Status | Tags |
|---|---|---|---|---|
| [001](001-hand-rolled-cli-parsing-and-frozen-dependency-budget.md) | Hand-rolled CLI parsing and a frozen three-package dependency budget | 2026-07-21 | Accepted (dependency budget amended by 002) | cli, dependencies, parsing |
| [002](002-node-runtime-compiled-ts-to-js.md) | Run on stock Node via a compiled TS→JS bin; Bun runtime dropped | 2026-07-22 | Accepted | runtime, node, packaging, build |
