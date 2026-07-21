// `clean` / `rm` — remove workspaces by filter (§9.9). M0: explicit slugs + --all.

import { existsSync } from "node:fs";
import { ExitCode, usage } from "../lib/errors.ts";
import { parseFlags } from "../cli/flags.ts";
import { acquireLock, loadState, saveState, type State, type Workspace } from "../core/state.ts";
import { disposeWorkspace, workspaceDiskBytes } from "../core/remove.ts";
import { isDirty } from "../git/worktree.ts";
import { slug as slugFor } from "../core/resolve.ts";
import type { ProjectInput, WorkspaceInput } from "./types.ts";
import type { Ctx, ProjectConfig } from "../config/schema.ts";

interface PlanEntry {
  ws: Workspace;
  reason: string;
  dirty: boolean;
  bytes: number | null;
}

function fmtBytes(bytes: number | null): string {
  if (bytes === null) return "?";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

async function buildPlan(targets: Workspace[]): Promise<PlanEntry[]> {
  const plan: PlanEntry[] = [];
  for (const ws of targets) {
    const present = existsSync(ws.path);
    const dirty = present && !ws.adopted ? await isDirty(ws.path) : false;
    const bytes = await workspaceDiskBytes(ws.adopted ? "" : ws.path);
    plan.push({ ws, reason: present ? "" : "missing", dirty, bytes });
  }
  return plan;
}

function confirm(ctx: Ctx, count: number): boolean {
  if (ctx.flags.yes) return true;
  if (!process.stdin.isTTY) {
    throw usage(`refusing to remove ${count} workspace(s) without confirmation`, "pass --yes for non-interactive use");
  }
  const answer = prompt(`Remove ${count} workspace(s)? [y/N]`);
  return answer !== null && /^y(es)?$/i.test(answer.trim());
}

async function execute(
  ctx: Ctx,
  project: ProjectConfig,
  state: State,
  plan: PlanEntry[],
  force: boolean,
): Promise<number> {
  let freed = 0;
  const removed: string[] = [];

  for (const entry of plan) {
    if (entry.dirty && !force) {
      ctx.log.warn(`skipping ${entry.ws.slug}: worktree is dirty (use --force)`);
      continue;
    }
    const disposed = await disposeWorkspace(ctx, project, entry.ws, force);
    if (!disposed) continue;
    delete state.workspaces[entry.ws.slug];
    removed.push(entry.ws.slug);
    if (entry.bytes) freed += entry.bytes;
  }

  if (!ctx.flags.dryRun) saveState(project.name, state);

  for (const slug of removed) process.stdout.write(`${slug}\n`);
  if (removed.length > 0) ctx.log.step(`freed ${fmtBytes(freed)}`);
  return ExitCode.SUCCESS;
}

export async function clean(input: ProjectInput): Promise<number> {
  const { ctx, project } = input;
  const flags = parseFlags(input.args, {
    bools: ["--all", "--include-adopted", "--force", "--yes", "--prune-state"],
    values: ["--older-than"],
  });
  if (flags.bool("--yes")) ctx.flags.yes = true;

  // M0 supports explicit slugs + --all. Other filters arrive in M1/M2.
  for (const unsupported of ["--older-than"]) {
    if (flags.value(unsupported)) throw usage(`${unsupported} is not available until M1`);
  }

  const explicit = flags.positionals;
  const all = flags.bool("--all");
  const includeAdopted = flags.bool("--include-adopted");

  if (!all && explicit.length === 0) {
    throw usage("clean requires explicit slugs or --all", "e.g. `uxd <project> clean pr-19234` or `uxd <project> clean --all`");
  }

  if (ctx.flags.dryRun) {
    return runClean(ctx, project, explicit, all, includeAdopted, flags.bool("--force"), true);
  }
  const lock = await acquireLock(project.name, ctx.log);
  try {
    return await runClean(ctx, project, explicit, all, includeAdopted, flags.bool("--force"), false);
  } finally {
    lock.release();
  }
}

async function runClean(
  ctx: Ctx,
  project: ProjectConfig,
  explicit: string[],
  all: boolean,
  includeAdopted: boolean,
  force: boolean,
  dryRun: boolean,
): Promise<number> {
  const state = loadState(project.name);
  let targets = Object.values(state.workspaces);

  if (!all) {
    const wanted = new Set(explicit);
    const found = new Set<string>();
    targets = targets.filter((w) => {
      if (wanted.has(w.slug)) {
        found.add(w.slug);
        return true;
      }
      return false;
    });
    const missing = explicit.filter((s) => !found.has(s));
    if (missing.length) throw usage(`no such workspace(s): ${missing.join(", ")}`);
  }

  // Adopted workspaces are skipped by filters unless explicitly included (§7.5).
  if (!includeAdopted && all) {
    targets = targets.filter((w) => !w.adopted);
  }

  if (targets.length === 0) {
    ctx.log.step("nothing to remove");
    return ExitCode.SUCCESS;
  }

  const plan = await buildPlan(targets);
  ctx.log.step("plan:");
  for (const e of plan) {
    const bits = [e.reason, e.dirty ? "dirty" : "clean", fmtBytes(e.bytes)].filter(Boolean).join(", ");
    process.stderr.write(`  ${e.ws.slug} (${bits})\n`);
  }

  if (!dryRun && !confirm(ctx, plan.length)) {
    ctx.log.step("aborted");
    return ExitCode.SUCCESS;
  }
  return execute(ctx, project, state, plan, force);
}

export async function rm(input: WorkspaceInput): Promise<number> {
  const { ctx, project, ref } = input;
  const flags = parseFlags(input.args, { bools: ["--force", "--yes"] });
  if (flags.bool("--yes")) ctx.flags.yes = true;
  const slug = slugFor(ref);

  if (ctx.flags.dryRun) {
    return runClean(ctx, project, [slug], false, true, flags.bool("--force"), true);
  }
  const lock = await acquireLock(project.name, ctx.log);
  try {
    return await runClean(ctx, project, [slug], false, true, flags.bool("--force"), false);
  } finally {
    lock.release();
  }
}
