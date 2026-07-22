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

export function addCommitWorktreeArgv(repoPath: string, dir: string, sha: string): string[] {
  return ["git", "-C", repoPath, "worktree", "add", "--detach", dir, sha];
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

/** Add a detached worktree at a specific commit sha (§7.2, M2). */
export async function addCommitWorktree(g: GitEnv, dir: string, sha: string): Promise<void> {
  const res = await runGit(g, addCommitWorktreeArgv(g.repoPath, dir, sha), { allowFailure: true });
  throwIfAlreadyCheckedOut(res, sha);
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

// ── sync helpers (§7.4) ──────────────────────────────────────────────────────

/** Current HEAD sha of a worktree. */
export async function worktreeHead(dir: string): Promise<string> {
  const res = await capture(["git", "-C", dir, "rev-parse", "HEAD"], {
    allowFailure: true,
    env: env(),
  });
  return res.code === 0 ? res.stdout.trim() : "";
}

/** True when the worktree's current branch has a configured upstream (`@{u}`). */
export async function hasUpstream(dir: string): Promise<boolean> {
  const res = await capture(["git", "-C", dir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
    allowFailure: true,
    env: env(),
  });
  return res.code === 0 && res.stdout.trim() !== "";
}

/** Hard-reset a worktree to `target` (a ref or sha). Non-zero exit throws E_GIT. */
export async function resetHard(dir: string, target: string): Promise<void> {
  await capture(["git", "-C", dir, "reset", "--hard", target], { env: env(), errCode: "E_GIT" });
}

/** `git clean -fd` — drop untracked files/dirs after a discard. */
export async function cleanUntracked(dir: string): Promise<void> {
  await capture(["git", "-C", dir, "clean", "-fd"], { env: env(), errCode: "E_GIT" });
}

/**
 * Stash the worktree's changes (including untracked) with `message`. Returns the
 * created stash ref (e.g. `stash@{0}`), or null when there was nothing to stash.
 */
export async function stashPush(dir: string, message: string): Promise<string | null> {
  const res = await capture(
    ["git", "-C", dir, "stash", "push", "--include-untracked", "-m", message],
    { allowFailure: true, env: env() },
  );
  if (res.code !== 0) throw new UxdError("E_GIT", `git stash push: ${res.stderr.trim()}`);
  if (/no local changes/i.test(res.stdout)) return null;
  return "stash@{0}";
}

/** Count files changed between two revisions in a worktree. */
export async function diffCount(dir: string, from: string, to: string): Promise<number> {
  if (!from || !to || from === to) return 0;
  const res = await capture(["git", "-C", dir, "diff", "--name-only", `${from}..${to}`], {
    allowFailure: true,
    env: env(),
  });
  if (res.code !== 0) return 0;
  return res.stdout.split("\n").filter((l) => l.trim() !== "").length;
}

/** List local branches merged into `origin/<base>` (git-only `--merged` fallback, §9.9). */
export async function mergedBranches(repoPath: string, base: string): Promise<Set<string>> {
  const res = await capture(["git", "-C", repoPath, "branch", "--merged", `origin/${base}`], {
    allowFailure: true,
    env: env(),
  });
  if (res.code !== 0) return new Set();
  const names = res.stdout
    .split("\n")
    .map((l) => l.replace(/^[*+ ]+/, "").trim())
    .filter((l) => l !== "" && !l.startsWith("("));
  return new Set(names);
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
