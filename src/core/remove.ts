// Workspace disposal (§7.5). Does the git/fs teardown; state mutation is the caller's.

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { capture } from "../lib/proc.ts";
import type { Ctx, ProjectConfig } from "../config/schema.ts";
import type { Workspace } from "./state.ts";
import { deleteBranch, pruneWorktrees, removeWorktree } from "../git/worktree.ts";
import { runHook } from "./hooks.ts";
import { wsContext } from "./env.ts";
import type { GitEnv } from "../git/repo.ts";

function dataDirFor(project: ProjectConfig, slug: string): string {
  return join(project.worktreesPath, ".data", slug);
}

function gitEnv(ctx: Ctx, project: ProjectConfig): GitEnv {
  return { repoPath: project.repoPath, dryRun: ctx.flags.dryRun, log: ctx.log };
}

/** Best-effort disk size in bytes via `du -sk` (§9.9). Returns null when unknown. */
export async function workspaceDiskBytes(dir: string): Promise<number | null> {
  if (!existsSync(dir)) return null;
  const res = await capture(["du", "-sk", dir], { allowFailure: true });
  if (res.code !== 0) return null;
  const kb = Number(res.stdout.trim().split(/\s+/)[0]);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

/**
 * Tear down one workspace (§7.5). Adopted workspaces keep their directory and
 * branch — only the data dir is removed. Returns true when disposed, false when
 * a pre_clean hook vetoed it.
 */
export async function disposeWorkspace(
  ctx: Ctx,
  project: ProjectConfig,
  ws: Workspace,
  force: boolean,
): Promise<boolean> {
  const dataDir = dataDirFor(project, ws.slug);

  try {
    await runHook(ctx, project, wsContext(project, ws, dataDir), "pre_clean", true);
  } catch {
    ctx.log.warn(`pre_clean hook failed for ${ws.slug} — skipping`);
    return false;
  }

  if (ctx.flags.dryRun) {
    if (!ws.adopted) {
      process.stdout.write(`git -C ${project.repoPath} worktree remove ${ws.path}${force ? " --force" : ""}\n`);
      if (ws.kind === "pr" && ws.number !== undefined) {
        process.stdout.write(`git -C ${project.repoPath} branch -D pr/${ws.number}\n`);
      }
    }
    process.stdout.write(`rm -rf ${dataDir}\n`);
    return true;
  }

  const g = gitEnv(ctx, project);

  if (!ws.adopted) {
    if (existsSync(ws.path)) {
      await removeWorktree(g, ws.path, force);
    }
    // PR branches are uxd-owned → always deletable; user branches only with --force.
    if (ws.kind === "pr" && ws.number !== undefined) {
      await deleteBranch(g, `pr/${ws.number}`);
    } else if (ws.kind === "branch" && ws.branch && force) {
      await deleteBranch(g, ws.branch);
    }
  }

  rmSync(dataDir, { recursive: true, force: true });

  if (!ws.adopted) {
    await pruneWorktrees(g);
  }
  return true;
}
