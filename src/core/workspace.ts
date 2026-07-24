// ensureWorkspace pipeline (§8.1): resolve → materialize → (setup).

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Ctx, ProjectConfig } from "../config/schema.ts";
import { resolveError } from "../lib/errors.ts";
import { resolvePath } from "../lib/paths.ts";
import { shellJoin } from "../lib/shell.ts";
import { collisionSlug, parseRef, slug as slugFor, type RefSpec } from "./resolve.ts";
import { acquireLock, loadState, saveState, type Workspace } from "./state.ts";
import { allocatePorts, tcpPortFree } from "./ports.ts";
import {
  addBranchWorktreeArgv,
  addPrWorktreeArgv,
  addCommitWorktreeArgv,
  addBranchWorktree,
  addPrWorktree,
  addCommitWorktree,
  isGitWorktree,
} from "../git/worktree.ts";
import {
  bareCloneArgv,
  detectDefaultBranch,
  fetchBranch,
  fetchCommit,
  fetchPr,
  refetchPr,
  initConfigArgvs,
  initFetchArgv,
  initPrimaryRepo,
  isInitialized,
  wireForkPushBack,
  wirePrPushBack,
  type GitEnv,
} from "../git/repo.ts";
import { wsContext } from "./env.ts";
import { runHook } from "./hooks.ts";
import { runSetup } from "./setup.ts";
import { fnv1a32 } from "../lib/hash.ts";

export interface EnsureOptions {
  setup: boolean;
  fetch?: boolean;
  /** Overwrite seed targets during setup (§8.4.1). */
  reseed?: boolean;
  /** Run the `pre_run` hook after setup — run/exec/shell only (§8.4.4). */
  preRun?: boolean;
}

export interface EnsureResult {
  ws: Workspace;
  created: boolean;
  dataDir: string;
}

/** `<worktrees_path>/.data/<slug>` — a workspace's private mutable data dir (§8.3). */
export function dataDirFor(project: ProjectConfig, slug: string): string {
  return join(project.worktreesPath, ".data", slug);
}

function gitEnv(ctx: Ctx, project: ProjectConfig, planned?: string[][]): GitEnv {
  return { repoPath: project.repoPath, dryRun: ctx.flags.dryRun, log: ctx.log, planned };
}

/** Resolve a `last` ref against saved state; other kinds pass through. */
export function resolveLast(project: ProjectConfig, spec: RefSpec): RefSpec {
  if (spec.kind !== "last") return spec;
  const state = loadState(project.name);
  if (!state.lastRef) throw resolveError(`no last-used ref for '${project.name}'`);
  return parseRef(state.lastRef);
}

/**
 * The pipeline. Idempotent; cheap when already materialized (fast path skips the
 * network). Takes the project lock for the mutating path (§8.1).
 */
export async function ensureWorkspace(
  ctx: Ctx,
  project: ProjectConfig,
  refSpec: RefSpec,
  opts: EnsureOptions,
): Promise<EnsureResult> {
  if (ctx.flags.dryRun) {
    return dryRunPlan(ctx, project, refSpec);
  }

  const lock = await acquireLock(project.name, ctx.log);
  try {
    const spec = resolveLast(project, refSpec);
    const state = loadState(project.name);
    const slug = slugFor(spec);

    const existing = state.workspaces[slug];
    let created = false;
    let ws: Workspace;

    if (existing && existsSync(existing.path)) {
      ws = existing;
      ctx.log.step("worktree ready (reused)");
      if (opts.fetch) await refetch(ctx, project, ws);
    } else {
      ws = await materialize(ctx, project, spec, slug, state.workspaces);
      created = true;
      state.workspaces[ws.slug] = ws;
      // Persist immediately so a failing post_checkout/setup below leaves the
      // worktree recorded in state — the next run resumes the hooks on the fast
      // path instead of hitting "already checked out" (§8.1, §8.4.3).
      state.lastRef = ws.ref;
      saveState(project.name, state);
    }

    const dataDir = dataDirFor(project, ws.slug);
    const wc = wsContext(project, ws, dataDir);

    if (created) {
      await runHook(ctx, project, wc, "post_checkout", true);
    }

    if (opts.setup) {
      await runSetup(ctx, project, ws, wc, {
        reseed: opts.reseed ?? false,
        preRun: opts.preRun ?? false,
      });
    }

    ws.lastUsedAt = new Date().toISOString();
    state.lastRef = ws.ref;
    saveState(project.name, state);
    return { ws, created, dataDir };
  } finally {
    lock.release();
  }
}

async function materialize(
  ctx: Ctx,
  project: ProjectConfig,
  spec: RefSpec,
  baseSlug: string,
  existing: Record<string, Workspace>,
): Promise<Workspace> {
  const now = new Date().toISOString();

  if (spec.kind === "path") {
    const abs = resolvePath(spec.path);
    if (!existsSync(abs)) throw resolveError(`path does not exist: ${abs}`);
    if (!(await isGitWorktree(abs))) throw resolveError(`not a git working tree: ${abs}`);
    const slug = baseSlug;
    const ports = await allocateFor(project, slug, existing);
    mkdirSync(dataDirFor(project, slug), { recursive: true });
    return {
      slug,
      ref: spec.path,
      kind: "path",
      path: abs,
      adopted: true,
      ports,
      createdAt: now,
      lastUsedAt: now,
    };
  }

  // Ensure the primary repo exists and is configured (§7.1).
  const g = gitEnv(ctx, project);
  if (!isInitialized(project.repoPath)) {
    await initPrimaryRepo(g, project.repo);
    if (!project.defaultBranch) {
      const detected = await detectDefaultBranch(g);
      if (detected) project.defaultBranch = detected;
    }
  }
  mkdirSync(project.worktreesPath, { recursive: true });

  // Resolve a slug collision against a *different* ref (§6.3).
  let slug = baseSlug;
  if (spec.kind === "branch" && existing[slug] && existing[slug]!.ref !== spec.name) {
    slug = collisionSlug(spec.name);
  }
  const dir = join(project.worktreesPath, slug);

  let branch: string | undefined;
  let number: number | undefined;
  let ref: string;
  if (spec.kind === "branch") {
    await fetchBranch(g, spec.name);
    await addBranchWorktree(g, dir, spec.name);
    branch = spec.name;
    ref = spec.name;
  } else if (spec.kind === "pr") {
    await fetchPr(g, spec.number);
    await addPrWorktree(g, dir, spec.number);
    branch = `pr/${spec.number}`;
    number = spec.number;
    ref = String(spec.number);
  } else if (spec.kind === "commit") {
    // commit ref (§6.2, §7.2): ensure the object is present, then detach (M2).
    await fetchCommit(g, spec.sha);
    await addCommitWorktree(g, dir, spec.sha);
    ref = spec.sha;
  } else {
    // `last` is resolved upstream by resolveLast(); reaching here is a bug.
    throw resolveError(`unresolved ref kind: ${spec.kind}`);
  }

  const ports = await allocateFor(project, slug, existing);
  mkdirSync(dataDirFor(project, slug), { recursive: true });

  const ws: Workspace = {
    slug,
    ref,
    kind: spec.kind as "branch" | "pr" | "commit",
    number,
    branch,
    path: dir,
    adopted: false,
    ports,
    createdAt: now,
    lastUsedAt: now,
  };

  if (spec.kind === "pr") {
    await wirePr(ctx, project, spec.number, ws);
  }

  return ws;
}

/** Best-effort same-repo PR push-back + metadata cache (§7.3). Degrades without gh. */
async function wirePr(ctx: Ctx, project: ProjectConfig, n: number, ws: Workspace): Promise<void> {
  if (!(await ctx.gh.available())) {
    ctx.log.warn(`gh unavailable — push-back not wired for pr/${n}`);
    return;
  }
  const repo = ghRepoSlug(project.repo);
  if (!repo) return;
  const meta = await ctx.gh.prView(repo, n);
  if (!meta) return;

  ws.pr = {
    title: meta.title,
    author: meta.author,
    state: meta.state,
    url: meta.url,
    headRefName: meta.headRefName,
    fetchedAt: new Date().toISOString(),
  };

  const g = gitEnv(ctx, project);
  if (!meta.isCrossRepository && meta.headRefName) {
    await wirePrPushBack(g, n, meta.headRefName);
  } else if (meta.isCrossRepository && meta.headRefName && meta.headRepositoryOwner) {
    const forkUrl = forkCloneUrl(project.repo, meta.headRepositoryOwner);
    if (forkUrl) {
      await wireForkPushBack(g, n, meta.headRepositoryOwner, forkUrl, meta.headRefName);
    } else {
      ctx.log.warn(`could not derive fork URL for ${meta.headRepositoryOwner} — push-back left read-only`);
    }
  } else if (meta.isCrossRepository) {
    ctx.log.warn("push-back unavailable for fork PRs without gh");
  }
}

/**
 * Build a fork's clone URL from the base repo URL by swapping the owner segment
 * (§7.3). Preserves the base's transport (ssh vs https) and `.git` suffix.
 */
export function forkCloneUrl(baseRepo: string, owner: string): string | null {
  const ssh = baseRepo.match(/^(git@[^:]+:)([^/]+)\/(.+)$/);
  if (ssh) return `${ssh[1]}${owner}/${ssh[3]}`;
  const https = baseRepo.match(/^(https?:\/\/[^/]+\/)([^/]+)\/(.+)$/);
  if (https) return `${https[1]}${owner}/${https[3]}`;
  return null;
}

/** Re-fetch on the fast path when `--fetch` is passed (§8.1). */
async function refetch(ctx: Ctx, project: ProjectConfig, ws: Workspace): Promise<void> {
  const g = gitEnv(ctx, project);
  if (ws.kind === "branch" && ws.branch) await fetchBranch(g, ws.branch);
  else if (ws.kind === "pr" && ws.number !== undefined) await refetchPr(g, ws.path, ws.number);
}

async function allocateFor(project: ProjectConfig, slug: string, existing: Record<string, Workspace>): Promise<number[]> {
  const reserved = new Set<number>();
  for (const w of Object.values(existing)) for (const p of w.ports) reserved.add(p);
  return await allocatePorts({
    slug,
    basePort: project.basePort,
    ports: project.ports,
    reserved,
    isFree: tcpPortFree,
  });
}

/** Extract `owner/name` from a clone URL for gh (§7.3). */
export function ghRepoSlug(repo: string): string | null {
  const ssh = repo.match(/^git@[^:]+:(.+?)(?:\.git)?$/);
  if (ssh) return ssh[1]!;
  const https = repo.match(/^https?:\/\/[^/]+\/(.+?)(?:\.git)?$/);
  if (https) return https[1]!;
  return null;
}

// ── Dry-run planning (§13.4) ────────────────────────────────────────────────

function dryRunPlan(ctx: Ctx, project: ProjectConfig, refSpec: RefSpec): EnsureResult {
  const spec = resolveLast(project, refSpec);
  const slug = slugFor(spec);
  const dir = join(project.worktreesPath, slug);
  const dataDir = dataDirFor(project, slug);
  const lines: string[] = [];

  const freshRepo = !isInitialized(project.repoPath);
  if (freshRepo) {
    lines.push(shellJoin(bareCloneArgv(project.repo, project.repoPath)));
    for (const argv of initConfigArgvs(project.repoPath)) lines.push(shellJoin(argv));
    lines.push(shellJoin(initFetchArgv(project.repoPath)));
  }
  lines.push(`mkdir -p ${project.worktreesPath}`);

  if (spec.kind === "branch") {
    lines.push(shellJoin(["git", "-C", project.repoPath, "fetch", "origin", spec.name, "--no-tags"]));
    lines.push(shellJoin(addBranchWorktreeArgv(project.repoPath, dir, spec.name)));
  } else if (spec.kind === "pr") {
    lines.push(
      shellJoin([
        "git",
        "-C",
        project.repoPath,
        "fetch",
        "origin",
        `+refs/pull/${spec.number}/head:refs/heads/pr/${spec.number}`,
        "--no-tags",
      ]),
    );
    lines.push(shellJoin(addPrWorktreeArgv(project.repoPath, dir, spec.number)));
  } else if (spec.kind === "commit") {
    lines.push(shellJoin(["git", "-C", project.repoPath, "fetch", "origin", spec.sha, "--no-tags"]));
    lines.push(shellJoin(addCommitWorktreeArgv(project.repoPath, dir, spec.sha)));
  }
  lines.push(`mkdir -p ${dataDir}`);

  for (const line of lines) process.stdout.write(`${line}\n`);

  const now = new Date().toISOString();
  const ws: Workspace = {
    slug,
    ref: spec.kind === "pr" ? String(spec.number) : spec.kind === "branch" ? spec.name : spec.kind === "commit" ? spec.sha : String(spec.kind),
    kind: spec.kind === "last" ? "branch" : spec.kind,
    number: spec.kind === "pr" ? spec.number : undefined,
    branch: spec.kind === "pr" ? `pr/${spec.number}` : spec.kind === "branch" ? spec.name : undefined,
    path: dir,
    adopted: spec.kind === "path",
    // Deterministic-only (no TCP probing, §8.5) so run/exec/shell --dry-run can
    // render {port}/UXD_PORT without taking a lock or binding a socket.
    ports: deterministicPorts(project, slug),
    createdAt: now,
    lastUsedAt: now,
  };
  return { ws, created: freshRepo, dataDir };
}

/** The deterministic-first port block for a slug, used only for dry-run display (§8.5). */
function deterministicPorts(project: ProjectConfig, slug: string): number[] {
  const base = project.basePort + (fnv1a32(slug) % 100) * project.ports;
  return Array.from({ length: project.ports }, (_, i) => base + i);
}
