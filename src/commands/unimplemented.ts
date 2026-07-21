// Verbs accepted by the parser but delivered in later milestones. They fail
// with a clear E_USAGE (exit 2) rather than a confusing "unknown command",
// so the CLI surface is honest about what M0 does and doesn't do (§18).

import { UxdError } from "../lib/errors.ts";
import type { TopInput, WorkspaceInput } from "./types.ts";

function notYet(verb: string, milestone: string): never {
  throw new UxdError("E_USAGE", `'${verb}' is not available in this build`, {
    hint: `${verb} lands in ${milestone}; M0 provides checkout, code, list, info, rm, clean, projects, doctor, config`,
  });
}

// ── M1: setup pipeline + process verbs ──────────────────────────────────────
export async function run(_input: WorkspaceInput): Promise<number> {
  return notYet("run", "M1");
}
export async function exec(_input: WorkspaceInput): Promise<number> {
  return notYet("exec", "M1");
}
export async function shell(_input: WorkspaceInput): Promise<number> {
  return notYet("shell", "M1");
}
export async function sync(_input: WorkspaceInput): Promise<number> {
  return notYet("sync", "M1");
}

// ── M2: diff + completions ──────────────────────────────────────────────────
export async function diff(_input: WorkspaceInput): Promise<number> {
  return notYet("diff", "M2");
}
export async function completions(_input: TopInput): Promise<number> {
  return notYet("completions", "M2");
}
