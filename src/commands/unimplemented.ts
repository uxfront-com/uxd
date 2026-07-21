// Verbs accepted by the parser but delivered in later milestones. They fail
// with a clear E_USAGE (exit 2) rather than a confusing "unknown command",
// so the CLI surface is honest about what M0 does and doesn't do (§18).

import { UxdError } from "../lib/errors.ts";
import type { TopInput, WorkspaceInput } from "./types.ts";

function notYet(verb: string, milestone: string): never {
  throw new UxdError("E_USAGE", `'${verb}' is not available in this build`, {
    hint: `${verb} lands in ${milestone}; this build provides checkout, code, list, info, run, exec, shell, sync, rm, clean, projects, doctor, config`,
  });
}

// ── M2: diff + completions ──────────────────────────────────────────────────
export async function diff(_input: WorkspaceInput): Promise<number> {
  return notYet("diff", "M2");
}
export async function completions(_input: TopInput): Promise<number> {
  return notYet("completions", "M2");
}
