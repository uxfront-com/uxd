// Primary repo init, fetch strategies, default-branch detection (§7.1–7.3).

import { existsSync } from "node:fs";
import { capture } from "../lib/proc.ts";
import { UxdError } from "../lib/errors.ts";
import type { Logger } from "../lib/log.ts";

export const MIN_GIT_VERSION = "2.38";

export interface GitEnv {
  repoPath: string;
  dryRun: boolean;
  log: Logger;
  /** Collector for dry-run command lines (argv arrays). */
  planned?: string[][];
}

const NON_INTERACTIVE = { GIT_TERMINAL_PROMPT: "0" } as const;

function env(): Record<string, string> {
  return { ...(process.env as Record<string, string>), ...NON_INTERACTIVE };
}

/** Execute a git argv, or record it when in dry-run. Read-only calls pass `read`. */
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

// ── Argv builders (pure — shared by exec + dry-run planning) ─────────────────

export function bareCloneArgv(repo: string, repoPath: string): string[] {
  return ["git", "clone", "--bare", "--filter=blob:none", repo, repoPath];
}

export function initConfigArgvs(repoPath: string): string[][] {
  return [
    ["git", "-C", repoPath, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
    ["git", "-C", repoPath, "config", "fetch.prune", "true"],
    ["git", "-C", repoPath, "config", "push.default", "upstream"],
  ];
}

export function initFetchArgv(repoPath: string): string[] {
  return ["git", "-C", repoPath, "fetch", "origin", "--no-tags"];
}

// ── Operations ───────────────────────────────────────────────────────────────

export function isInitialized(repoPath: string): boolean {
  return existsSync(repoPath);
}

/** Clone the bare partial repo and apply the required config + first fetch (§7.1). */
export async function initPrimaryRepo(g: GitEnv, repo: string): Promise<void> {
  g.log.step(`cloning ${repo} (bare, partial)`);
  await runGit(g, bareCloneArgv(repo, g.repoPath));
  for (const argv of initConfigArgvs(g.repoPath)) {
    await runGit(g, argv);
  }
  await runGit(g, initFetchArgv(g.repoPath));
}

/** Detect origin's default branch via ls-remote --symref (§7.1). */
export async function detectDefaultBranch(g: GitEnv): Promise<string | undefined> {
  if (g.dryRun) return undefined;
  const res = await runGit(g, ["git", "-C", g.repoPath, "ls-remote", "--symref", "origin", "HEAD"], {
    read: true,
    allowFailure: true,
  });
  const m = res.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
  return m?.[1];
}

/** Fetch a branch's remote-tracking ref (§7.2). */
export async function fetchBranch(g: GitEnv, name: string): Promise<void> {
  g.log.step(`fetching origin/${name}`);
  const res = await runGit(g, ["git", "-C", g.repoPath, "fetch", "origin", name, "--no-tags"], {
    allowFailure: true,
  });
  if (res.code !== 0) throw classifyFetchError(res.stderr, `branch '${name}'`);
}

/** Force-fetch a PR head into a local `pr/<n>` branch (§7.2). */
export async function fetchPr(g: GitEnv, n: number): Promise<void> {
  g.log.step(`fetching pull/${n} → pr/${n}`);
  const res = await runGit(
    g,
    ["git", "-C", g.repoPath, "fetch", "origin", `+refs/pull/${n}/head:refs/heads/pr/${n}`, "--no-tags"],
    { allowFailure: true },
  );
  if (res.code !== 0) throw classifyFetchError(res.stderr, `PR #${n}`);
}

/**
 * Ensure a commit object is present locally, fetching it from origin if the
 * partial clone hasn't materialized it yet (§6.2, §7.2). A commit already on a
 * fetched branch is present after the init fetch and needs no network.
 */
export async function fetchCommit(g: GitEnv, sha: string): Promise<void> {
  if (!g.dryRun && (await commitPresent(g.repoPath, sha))) return;
  g.log.step(`fetching commit ${sha.slice(0, 10)}`);
  const res = await runGit(g, ["git", "-C", g.repoPath, "fetch", "origin", sha, "--no-tags"], {
    allowFailure: true,
  });
  if (res.code !== 0) throw classifyFetchError(res.stderr, `commit ${sha.slice(0, 10)}`);
}

/** True when `sha` resolves to a commit object in the local repo. */
async function commitPresent(repoPath: string, sha: string): Promise<boolean> {
  const res = await capture(["git", "-C", repoPath, "cat-file", "-e", `${sha}^{commit}`], {
    allowFailure: true,
    env: env(),
  });
  return res.code === 0;
}

/**
 * A failed fetch is E_RESOLVE (exit 4) when the ref simply isn't on origin, and
 * E_GIT (exit 5) for any other transport/plumbing failure (§14).
 */
function classifyFetchError(stderr: string, ref: string): UxdError {
  const detail = stderr.trim();
  if (
    /couldn't find remote ref|no such ref|remote ref .* not found|not our ref|unadvertised object|did not send all necessary objects/i.test(
      detail,
    )
  ) {
    return new UxdError("E_RESOLVE", `${ref} does not exist on origin`, {
      hint: "check the name, or push the ref first",
    });
  }
  return new UxdError("E_GIT", `git fetch failed for ${ref}: ${detail || "unknown error"}`);
}

/** Wire same-repo PR push-back so a plain `git push` targets the agent branch (§7.3). */
export async function wirePrPushBack(g: GitEnv, n: number, headRefName: string): Promise<void> {
  await runGit(g, ["git", "-C", g.repoPath, "config", `branch.pr/${n}.remote`, "origin"]);
  await runGit(g, [
    "git",
    "-C",
    g.repoPath,
    "config",
    `branch.pr/${n}.merge`,
    `refs/heads/${headRefName}`,
  ]);
  g.log.step(`push-back wired to origin/${headRefName}`);
}

/**
 * Wire fork-PR push-back (§7.3, M2): add (or reuse) a `fork-<owner>` remote for
 * the contributor's clone, fetch the PR head branch onto it, and point the local
 * `pr/<n>` branch's upstream at `fork-<owner>/<headRefName>` so a plain push
 * lands on the fork. Best-effort — a fetch failure degrades to read-only.
 */
export async function wireForkPushBack(
  g: GitEnv,
  n: number,
  owner: string,
  forkUrl: string,
  headRefName: string,
): Promise<void> {
  const remote = `fork-${owner}`;
  if (!(await remoteExists(g.repoPath, remote))) {
    await runGit(g, ["git", "-C", g.repoPath, "remote", "add", remote, forkUrl]);
  } else {
    await runGit(g, ["git", "-C", g.repoPath, "remote", "set-url", remote, forkUrl]);
  }
  const fetched = await runGit(
    g,
    ["git", "-C", g.repoPath, "fetch", remote, headRefName, "--no-tags"],
    { allowFailure: true },
  );
  if (!g.dryRun && fetched.code !== 0) {
    g.log.warn(`fork fetch failed for ${remote}/${headRefName} — push-back left read-only`);
    return;
  }
  await runGit(g, ["git", "-C", g.repoPath, "config", `branch.pr/${n}.remote`, remote]);
  await runGit(g, ["git", "-C", g.repoPath, "config", `branch.pr/${n}.merge`, `refs/heads/${headRefName}`]);
  g.log.step(`fork push-back wired to ${remote}/${headRefName}`);
}

/** True when a named remote is already configured. */
async function remoteExists(repoPath: string, remote: string): Promise<boolean> {
  const res = await capture(["git", "-C", repoPath, "remote", "get-url", remote], {
    allowFailure: true,
    env: env(),
  });
  return res.code === 0;
}

/** Parse `git --version` into a comparable string; throws E_GIT if too old. */
export async function checkGitVersion(): Promise<{ ok: boolean; version: string }> {
  const res = await capture(["git", "--version"], { allowFailure: true });
  const m = res.stdout.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return { ok: false, version: res.stdout.trim() };
  const version = `${m[1]}.${m[2]}${m[3] ? `.${m[3]}` : ""}`;
  return { ok: compareVersion(version, MIN_GIT_VERSION) >= 0, version };
}

export function compareVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** `git rev-parse --is-bare-repository` — used by doctor (§9.11). */
export async function isBareRepo(repoPath: string): Promise<boolean> {
  const res = await capture(["git", "-C", repoPath, "rev-parse", "--is-bare-repository"], {
    allowFailure: true,
    env: env(),
  });
  return res.code === 0 && res.stdout.trim() === "true";
}

/** Read the configured fetch refspec (doctor §9.11, gotcha §19.1). */
export async function fetchRefspecConfigured(repoPath: string): Promise<boolean> {
  const res = await capture(
    ["git", "-C", repoPath, "config", "--get-all", "remote.origin.fetch"],
    { allowFailure: true, env: env() },
  );
  return res.code === 0 && res.stdout.includes("refs/remotes/origin/*");
}

/**
 * Read `core.hooksPath` from a repo, if set (doctor §9.11, gotcha §19.4–5).
 * A hooks path (often husky's `.husky`) can resolve wrong from worktrees.
 */
export async function hooksPathConfigured(repoPath: string): Promise<string | null> {
  const res = await capture(["git", "-C", repoPath, "config", "--get", "core.hooksPath"], {
    allowFailure: true,
    env: env(),
  });
  const val = res.stdout.trim();
  return res.code === 0 && val !== "" ? val : null;
}
