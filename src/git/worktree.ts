// Worktree add/remove/prune/status (§7.2, §7.5).

import { capture } from "../lib/proc.ts";
import { UxdError } from "../lib/errors.ts";
import type { GitEnv } from "./repo.ts";

const env = () => ({ ...(process.env as Record<string, string>), GIT_TERMINAL_PROMPT: "0" });

async function runGit(
  g: GitEnv,
  argv: string[],
  opts: { read?: boolean; allowFailure?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (g.dryRun && !opts.read) {
    g.planned?.push(argv);
    return { code: 0, stdout: "", stderr: "" };
  }
  g.log.debug(argv.join(" "));
  return capture(argv, { env: env(), errCode: "E_GIT", allowFailure: opts.allowFailure });
}

// ── Argv builders ────────────────────────────────────────────────────────────

export function addBranchWorktreeArgv(repoPath: string, dir: string, name: string): string[] {
  return ["git", "-C", repoPath, "worktree", "add", dir, "-B", name, "--track", `origin/${name}`];
}

export function addPrWorktreeArgv(repoPath: string, dir: string, n: number): string[] {
  return ["git", "-C", repoPath, "worktree", "add", dir, `pr/${n}`];
}

// ── Operations ───────────────────────────────────────────────────────────────

/** Add a worktree for a branch ref; surfaces the "already checked out" dedupe path (§7.2). */
export async function addBranchWorktree(g: GitEnv, dir: string, name: string): Promise<void> {
  const res = await runGit(g, addBranchWorktreeArgv(g.repoPath, dir, name), { allowFailure: true });
  throwIfAlreadyCheckedOut(res, name);
  if (res.code !== 0) throw new UxdError("E_GIT", `git worktree add: ${res.stderr.trim()}`);
  g.log.step(`worktree ready: ${dir}`);
}

/** Add a worktree for a PR ref (`pr/<n>`). */
export async function addPrWorktree(g: GitEnv, dir: string, n: number): Promise<void> {
  const res = await runGit(g, addPrWorktreeArgv(g.repoPath, dir, n), { allowFailure: true });
  throwIfAlreadyCheckedOut(res, `pr/${n}`);
  if (res.code !== 0) throw new UxdError("E_GIT", `git worktree add: ${res.stderr.trim()}`);
  g.log.step(`worktree ready: ${dir}`);
}

function throwIfAlreadyCheckedOut(
  res: { code: number; stderr: string },
  ref: string,
): void {
  if (res.code !== 0 && /already (checked out|used by worktree)/i.test(res.stderr)) {
    throw new UxdError("E_GIT", `'${ref}' is already checked out in another workspace`, {
      hint: "use that workspace, or remove it first with `uxd <project> <ref> rm`",
    });
  }
}

/** Remove a worktree; `force` allows removing a dirty tree (§7.5, §19.12). */
export async function removeWorktree(g: GitEnv, dir: string, force: boolean): Promise<void> {
  const argv = ["git", "-C", g.repoPath, "worktree", "remove", dir];
  if (force) argv.push("--force");
  await runGit(g, argv, { allowFailure: false });
}

/** Delete a local branch (`-D`). */
export async function deleteBranch(g: GitEnv, branch: string): Promise<void> {
  await runGit(g, ["git", "-C", g.repoPath, "branch", "-D", branch], { allowFailure: true });
}

/** `git worktree prune` — clean up metadata after manual dir removal (§19.8). */
export async function pruneWorktrees(g: GitEnv): Promise<void> {
  await runGit(g, ["git", "-C", g.repoPath, "worktree", "prune"]);
}

/** True when the worktree has uncommitted changes (§9.8, §9.9). */
export async function isDirty(worktreeDir: string): Promise<boolean> {
  const res = await capture(["git", "-C", worktreeDir, "status", "--porcelain"], {
    allowFailure: true,
    env: env(),
  });
  return res.code === 0 && res.stdout.trim() !== "";
}

/** List worktree directories known to git (for doctor orphan detection, §9.11). */
export async function listWorktrees(repoPath: string): Promise<string[]> {
  const res = await capture(["git", "-C", repoPath, "worktree", "list", "--porcelain"], {
    allowFailure: true,
    env: env(),
  });
  if (res.code !== 0) return [];
  const dirs: string[] = [];
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("worktree ")) dirs.push(line.slice("worktree ".length));
  }
  return dirs;
}

/** Validate an adopted path is a git working tree (§6.2). */
export async function isGitWorktree(path: string): Promise<boolean> {
  const res = await capture(["git", "-C", path, "rev-parse", "--git-dir"], {
    allowFailure: true,
    env: env(),
  });
  return res.code === 0;
}
