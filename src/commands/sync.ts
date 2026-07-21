// sync — re-fetch and hard-reset a workspace to its ref (§7.4, §9.6).

import { existsSync } from "node:fs";
import { ExitCode, gitError, resolveError, usage } from "../lib/errors.ts";
import { parseFlags } from "../cli/flags.ts";
import { acquireLock, loadState, saveState } from "../core/state.ts";
import { slug as slugFor } from "../core/resolve.ts";
import { dataDirFor, ensureWorkspace, resolveLast } from "../core/workspace.ts";
import { disposeWorkspace } from "../core/remove.ts";
import { wsContext } from "../core/env.ts";
import { runHook } from "../core/hooks.ts";
import { fetchBranch, fetchPr, type GitEnv } from "../git/repo.ts";
import {
  cleanUntracked,
  diffCount,
  hasUpstream,
  isDirty,
  resetHard,
  stashPush,
  worktreeHead,
} from "../git/worktree.ts";
import type { Ctx, ProjectConfig } from "../config/schema.ts";
import type { Workspace } from "../core/state.ts";
import type { RefSpec } from "../core/resolve.ts";
import type { WorkspaceInput } from "./types.ts";

type Mode = "default" | "stash" | "discard" | "fresh";

export async function sync(input: WorkspaceInput): Promise<number> {
  const { ctx, project, ref } = input;
  const flags = parseFlags(input.args, { bools: ["--stash", "--discard", "--fresh"] });
  const mode = pickMode(flags.bool("--stash"), flags.bool("--discard"), flags.bool("--fresh"));

  if (ctx.flags.dryRun) return dryRunSync(ctx, project, ref, mode);

  if (mode === "fresh") return syncFresh(ctx, project, ref);
  return syncReset(ctx, project, ref, mode);
}

function pickMode(stash: boolean, discard: boolean, fresh: boolean): Mode {
  const on = [stash, discard, fresh].filter(Boolean).length;
  if (on > 1) throw usage("--stash, --discard, and --fresh are mutually exclusive");
  if (stash) return "stash";
  if (discard) return "discard";
  if (fresh) return "fresh";
  return "default";
}

function gitEnv(ctx: Ctx, project: ProjectConfig): GitEnv {
  return { repoPath: project.repoPath, dryRun: ctx.flags.dryRun, log: ctx.log };
}

/** Locate an existing, on-disk workspace for `ref`, or throw E_RESOLVE. */
function requireWorkspace(project: ProjectConfig, ref: RefSpec): { spec: RefSpec; slug: string; ws: Workspace } {
  const spec = resolveLast(project, ref);
  const slug = slugFor(spec);
  const state = loadState(project.name);
  const ws = state.workspaces[slug];
  if (!ws || !existsSync(ws.path)) {
    throw resolveError(`no workspace for '${slug}'`, "run `uxd <project> <ref> checkout` first");
  }
  return { spec, slug, ws };
}

async function syncReset(ctx: Ctx, project: ProjectConfig, ref: RefSpec, mode: Mode): Promise<number> {
  const lock = await acquireLock(project.name, ctx.log);
  try {
    const state = loadState(project.name);
    const spec = resolveLast(project, ref);
    const slug = slugFor(spec);
    const ws = state.workspaces[slug];
    if (!ws || !existsSync(ws.path)) {
      throw resolveError(`no workspace for '${slug}'`, "run `uxd <project> <ref> checkout` first");
    }

    // 1. Re-fetch for the workspace's kind (forced for PRs, §7.4.1).
    const g = gitEnv(ctx, project);
    if (ws.kind === "pr" && ws.number !== undefined) await fetchPr(g, ws.number);
    else if (ws.kind === "branch" && ws.branch) await fetchBranch(g, ws.branch);

    // 2. Determine the reset target (§7.4.2).
    const target = await resolveTarget(ws);

    const oldSha = await worktreeHead(ws.path);

    // 3. Handle a dirty tree (§7.4.3).
    let stashRef: string | null = null;
    if (await isDirty(ws.path)) {
      if (mode === "stash") {
        stashRef = await stashPush(ws.path, `uxd sync ${new Date().toISOString()}`);
      } else if (mode === "discard") {
        await resetHard(ws.path, "HEAD");
        await cleanUntracked(ws.path);
      } else {
        throw gitError("worktree has uncommitted changes", "re-run with --stash or --discard, or commit them");
      }
    }

    // 4. Hard-reset to the target (§7.4.4).
    await resetHard(ws.path, target);
    const newSha = await worktreeHead(ws.path);
    const changed = await diffCount(ws.path, oldSha, newSha);

    // 5. post_sync hook — warn-only (§7.4.5, §12).
    await runHook(ctx, project, wsContext(project, ws, dataDirFor(project, ws.slug)), "post_sync", false);

    ws.lastUsedAt = new Date().toISOString();
    saveState(project.name, state);

    const summary = [`${short(oldSha)} → ${short(newSha)}`, `${changed} file(s) changed`];
    if (stashRef) summary.push(`stashed ${stashRef}`);
    ctx.log.step(summary.join(", "));
    return ExitCode.SUCCESS;
  } finally {
    lock.release();
  }
}

/** `--fresh`: remove the workspace, then re-materialize it (§7.4.6). */
async function syncFresh(ctx: Ctx, project: ProjectConfig, ref: RefSpec): Promise<number> {
  {
    const lock = await acquireLock(project.name, ctx.log);
    try {
      const state = loadState(project.name);
      const spec = resolveLast(project, ref);
      const slug = slugFor(spec);
      const ws = state.workspaces[slug];
      if (!ws) throw resolveError(`no workspace for '${slug}'`, "run `uxd <project> <ref> checkout` first");

      if (existsSync(ws.path) && !ws.adopted && (await isDirty(ws.path))) {
        throw gitError(
          "worktree is dirty; refusing --fresh",
          "commit/stash your changes, or `uxd <project> <ref> rm --force` first",
        );
      }
      await disposeWorkspace(ctx, project, ws, false);
      delete state.workspaces[slug];
      saveState(project.name, state);
    } finally {
      lock.release();
    }
  }

  // Re-materialize under ensureWorkspace's own lock (no nesting).
  const { ws } = await ensureWorkspace(ctx, project, ref, { setup: false });
  ctx.log.step(`recreated ${ws.slug}`);
  return ExitCode.SUCCESS;
}

async function resolveTarget(ws: Workspace): Promise<string> {
  if (ws.kind === "pr" && ws.number !== undefined) return `refs/heads/pr/${ws.number}`;
  if (await hasUpstream(ws.path)) return "@{u}";
  return ws.branch ?? "HEAD";
}

function dryRunSync(ctx: Ctx, project: ProjectConfig, ref: RefSpec, mode: Mode): number {
  const { ws } = requireWorkspace(project, ref);
  const fetchArgv =
    ws.kind === "pr" && ws.number !== undefined
      ? ["git", "-C", project.repoPath, "fetch", "origin", `+refs/pull/${ws.number}/head:refs/heads/pr/${ws.number}`, "--no-tags"]
      : ["git", "-C", project.repoPath, "fetch", "origin", ws.branch ?? "HEAD", "--no-tags"];
  const target = ws.kind === "pr" && ws.number !== undefined ? `refs/heads/pr/${ws.number}` : "@{u}";

  process.stdout.write(`${fetchArgv.join(" ")}\n`);
  if (mode === "fresh") {
    process.stdout.write(`git -C ${project.repoPath} worktree remove ${ws.path}\n`);
  } else {
    if (mode === "discard") {
      process.stdout.write(`git -C ${ws.path} reset --hard HEAD\n`);
      process.stdout.write(`git -C ${ws.path} clean -fd\n`);
    }
    process.stdout.write(`git -C ${ws.path} reset --hard ${target}\n`);
  }
  return ExitCode.SUCCESS;
}

function short(sha: string): string {
  return sha ? sha.slice(0, 8) : "(none)";
}
