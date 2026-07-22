// `clean` / `rm` — remove workspaces by filter (§9.9): explicit slugs, --all,
// --older-than, and --merged (git-only fallback via `git branch --merged`).

import { existsSync } from "node:fs";
import { ExitCode, usage } from "../lib/errors.ts";
import { parseFlags } from "../cli/flags.ts";
import { acquireLock, loadState, saveState, type State, type Workspace } from "../core/state.ts";
import { disposeWorkspace, workspaceDiskBytes } from "../core/remove.ts";
import { isDirty, mergedBranches } from "../git/worktree.ts";
import { fetchBranch, type GitEnv } from "../git/repo.ts";
import { ghRepoSlug } from "../core/workspace.ts";
import { slug as slugFor } from "../core/resolve.ts";
import { promptLine } from "../lib/prompt.ts";
import type { ProjectInput, WorkspaceInput } from "./types.ts";
import type { Ctx, ProjectConfig } from "../config/schema.ts";

interface PlanEntry {
  ws: Workspace;
  reason: string;
  dirty: boolean;
  bytes: number | null;
}

/** Selection criteria for `clean`. Explicit slugs bypass all of these (§9.9). */
interface Filters {
  all: boolean;
  olderThanMs?: number;
  merged: boolean;
  /** PRs whose upstream PR is closed/merged (gh state, else git --merged). */
  closed: boolean;
  /** State entries whose worktree directory is gone (§9.11 doctor hint). */
  pruneState: boolean;
}

function fmtBytes(bytes: number | null): string {
  if (bytes === null) return "?";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

async function buildPlan(targets: Workspace[], reasons: Map<string, string>): Promise<PlanEntry[]> {
  const plan: PlanEntry[] = [];
  for (const ws of targets) {
    const present = existsSync(ws.path);
    const dirty = present && !ws.adopted ? await isDirty(ws.path) : false;
    const bytes = await workspaceDiskBytes(ws.adopted ? "" : ws.path);
    const reason = [present ? "" : "missing", reasons.get(ws.slug) ?? ""].filter(Boolean).join(", ");
    plan.push({ ws, reason, dirty, bytes });
  }
  return plan;
}

function confirm(ctx: Ctx, count: number): boolean {
  if (ctx.flags.yes) return true;
  if (!process.stdin.isTTY) {
    throw usage(`refusing to remove ${count} workspace(s) without confirmation`, "pass --yes for non-interactive use");
  }
  const answer = promptLine(`Remove ${count} workspace(s)? [y/N]`);
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
    bools: ["--all", "--merged", "--closed", "--include-adopted", "--force", "--yes", "--prune-state"],
    values: ["--older-than"],
  });
  if (flags.bool("--yes")) ctx.flags.yes = true;

  const explicit = flags.positionals;
  const includeAdopted = flags.bool("--include-adopted");
  const filters: Filters = {
    all: flags.bool("--all"),
    olderThanMs: parseOlderThan(flags.value("--older-than")),
    merged: flags.bool("--merged"),
    closed: flags.bool("--closed"),
    pruneState: flags.bool("--prune-state"),
  };

  const hasFilter =
    filters.all ||
    filters.merged ||
    filters.closed ||
    filters.pruneState ||
    filters.olderThanMs !== undefined;
  if (explicit.length === 0 && !hasFilter) {
    throw usage(
      "clean requires explicit slugs or a filter",
      "e.g. `uxd <project> clean pr-19234`, `--all`, `--merged`, `--closed`, `--prune-state`, or `--older-than 7d`",
    );
  }
  if (explicit.length > 0 && hasFilter) {
    throw usage("explicit slugs cannot be combined with --all/--merged/--closed/--prune-state/--older-than");
  }

  if (ctx.flags.dryRun) {
    return runClean(ctx, project, explicit, filters, includeAdopted, flags.bool("--force"), true);
  }
  const lock = await acquireLock(project.name, ctx.log);
  try {
    return await runClean(ctx, project, explicit, filters, includeAdopted, flags.bool("--force"), false);
  } finally {
    lock.release();
  }
}

/** Parse `--older-than 7d` / `36h` / `90m` into milliseconds (§9.9). */
function parseOlderThan(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const m = /^(\d+)([smhdw])$/.exec(raw.trim());
  if (!m) throw usage(`invalid --older-than '${raw}'`, "use a count + unit, e.g. 90m, 36h, 7d, 2w");
  const n = Number(m[1]);
  const unit = m[2]!;
  const scale: Record<string, number> = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };
  return n * scale[unit]!;
}

async function runClean(
  ctx: Ctx,
  project: ProjectConfig,
  explicit: string[],
  filters: Filters,
  includeAdopted: boolean,
  force: boolean,
  dryRun: boolean,
): Promise<number> {
  const state = loadState(project.name);
  const all = Object.values(state.workspaces);
  const reasons = new Map<string, string>();
  let targets: Workspace[];

  if (explicit.length > 0) {
    // Explicit slugs select exactly those workspaces, adopted or not (§9.9).
    const bySlug = new Map(all.map((w) => [w.slug, w]));
    const missing = explicit.filter((s) => !bySlug.has(s));
    if (missing.length) throw usage(`no such workspace(s): ${missing.join(", ")}`);
    targets = explicit.map((s) => bySlug.get(s)!);
  } else {
    targets = await selectByFilters(ctx, project, all, filters, includeAdopted, reasons);
  }

  if (targets.length === 0) {
    ctx.log.step("nothing to remove");
    return ExitCode.SUCCESS;
  }

  const plan = await buildPlan(targets, reasons);
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

/**
 * Apply --all / --older-than / --merged. Multiple filters intersect (a workspace
 * must satisfy every active one). Adopted workspaces are excluded unless
 * --include-adopted (§7.5). Collects human reasons for the plan display.
 */
async function selectByFilters(
  ctx: Ctx,
  project: ProjectConfig,
  all: Workspace[],
  filters: Filters,
  includeAdopted: boolean,
  reasons: Map<string, string>,
): Promise<Workspace[]> {
  const now = Date.now();
  const merged = filters.merged ? await mergedSlugs(ctx, project, all) : null;
  const closed = filters.closed ? await closedSlugs(ctx, project, all) : null;

  const selected: Workspace[] = [];
  for (const ws of all) {
    if (ws.adopted && !includeAdopted) continue;

    const why: string[] = [];
    if (filters.pruneState) {
      if (existsSync(ws.path)) continue; // only entries whose worktree is gone
      why.push("state-only");
    }
    if (filters.olderThanMs !== undefined) {
      const age = now - Date.parse(ws.lastUsedAt);
      if (!(age >= filters.olderThanMs)) continue;
      why.push(`idle ${fmtAge(age)}`);
    }
    if (filters.merged) {
      if (!merged!.has(ws.slug)) continue;
      why.push("merged");
    }
    if (filters.closed) {
      if (!closed!.has(ws.slug)) continue;
      why.push("closed");
    }
    // --all with no narrowing filter takes everything above.
    reasons.set(ws.slug, why.join(", "));
    selected.push(ws);
  }
  return selected;
}

/**
 * Slugs whose upstream PR is closed or merged (§9.9). Prefers gh's authoritative
 * state, then a cached `ws.pr.state`, and finally falls back to the git-only
 * `--merged` heuristic when neither is available.
 */
async function closedSlugs(ctx: Ctx, project: ProjectConfig, all: Workspace[]): Promise<Set<string>> {
  const slugs = new Set<string>();
  const prs = all.filter((w) => w.kind === "pr" && w.number !== undefined);
  if (prs.length === 0) return slugs;

  const isClosed = (state: string) => {
    const s = state.toUpperCase();
    return s === "CLOSED" || s === "MERGED";
  };

  if (await ctx.gh.available()) {
    const repo = ghRepoSlug(project.repo);
    if (repo) {
      for (const ws of prs) {
        const meta = await ctx.gh.prView(repo, ws.number!);
        if (isClosed(meta?.state ?? ws.pr?.state ?? "")) slugs.add(ws.slug);
      }
      return slugs;
    }
  }

  // No gh: trust cached PR state if any workspace carries it.
  let anyCached = false;
  for (const ws of prs) {
    if (ws.pr?.state) {
      anyCached = true;
      if (isClosed(ws.pr.state)) slugs.add(ws.slug);
    }
  }
  if (anyCached) return slugs;

  // Last resort: a PR branch merged into the default branch counts as closed.
  return mergedSlugs(ctx, project, all);
}

/** Slugs whose branch is merged into origin/<default> (git-only, no gh). */
async function mergedSlugs(ctx: Ctx, project: ProjectConfig, all: Workspace[]): Promise<Set<string>> {
  const base = project.defaultBranch ?? "main";
  const g: GitEnv = { repoPath: project.repoPath, dryRun: false, log: ctx.log };
  // Best-effort refresh so the merge check sees the latest default branch.
  try {
    await fetchBranch(g, base);
  } catch {
    // offline / no such branch — fall back to whatever is local
  }
  const branches = await mergedBranches(project.repoPath, base);
  const slugs = new Set<string>();
  for (const ws of all) {
    if (ws.branch && ws.branch !== base && branches.has(ws.branch)) slugs.add(ws.slug);
  }
  return slugs;
}

function fmtAge(ms: number): string {
  const days = Math.floor(ms / 864e5);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(ms / 36e5);
  if (hours >= 1) return `${hours}h`;
  return `${Math.max(1, Math.floor(ms / 6e4))}m`;
}

export async function rm(input: WorkspaceInput): Promise<number> {
  const { ctx, project, ref } = input;
  const flags = parseFlags(input.args, { bools: ["--force", "--yes"] });
  if (flags.bool("--yes")) ctx.flags.yes = true;
  const slug = slugFor(ref);
  const noFilters: Filters = { all: false, merged: false, closed: false, pruneState: false };

  if (ctx.flags.dryRun) {
    return runClean(ctx, project, [slug], noFilters, true, flags.bool("--force"), true);
  }
  const lock = await acquireLock(project.name, ctx.log);
  try {
    return await runClean(ctx, project, [slug], noFilters, true, flags.bool("--force"), false);
  } finally {
    lock.release();
  }
}
