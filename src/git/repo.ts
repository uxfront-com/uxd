// Primary repo init, fetch strategies, default-branch detection (§7.1–7.3).

import { existsSync } from "node:fs";
import { capture, captureBytes } from "../lib/proc.ts";
import { TestlaneError, resolveError } from "../lib/errors.ts";
import { isValidBranchName } from "../core/resolve.ts";
import type { Logger } from "../lib/log.ts";

export const MIN_GIT_VERSION = "2.38";

export interface GitEnv {
  repoPath: string;
  dryRun: boolean;
  log: Logger;
  /** Collector for dry-run command lines (argv arrays). */
  planned?: string[][];
  /** Kills a running git command when it fires (`testlane mcp`). */
  signal?: AbortSignal;
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
  return capture(argv, { env: env(), errCode: "E_GIT", allowFailure: opts.allowFailure, signal: g.signal });
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

/**
 * Fetch one branch into its own remote-tracking ref, and nothing else (§7.2).
 * The name is checked and the refspec spelled out, so a name like
 * `+refs/pull/7/head:refs/remotes/origin/main` can never move another ref.
 */
export function fetchBranchArgv(repoPath: string, name: string): string[] {
  if (!isValidBranchName(name)) {
    throw resolveError(`'${name}' is not a valid branch name`, "git refuses it as a branch name, or would read it as a refspec");
  }
  return [
    "git",
    "-C",
    repoPath,
    "fetch",
    "--no-tags",
    "origin",
    "--end-of-options",
    `+refs/heads/${name}:refs/remotes/origin/${name}`,
  ];
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
  const argv = fetchBranchArgv(g.repoPath, name);
  await refuseCaseCollision(g, name);
  g.log.step(`fetching origin/${name}`);
  const res = await runGit(g, argv, { allowFailure: true });
  if (res.code !== 0) throw classifyFetchError(res.stderr, `branch '${name}'`);
}

/** How a case- and normalization-insensitive filesystem (APFS, NTFS) compares names. */
function foldName(name: string): string {
  return name.normalize("NFD").toLowerCase();
}

/**
 * On a filesystem that ignores case (git sets `core.ignorecase` when it creates
 * the repo), `refs/remotes/origin/Main` is the same file as `.../main`, so a
 * forced fetch of `Main` would move `origin/main`. Refuse a name that differs
 * from an existing remote-tracking ref only in case or Unicode normalization.
 */
async function refuseCaseCollision(g: GitEnv, name: string): Promise<void> {
  if (g.dryRun || !isInitialized(g.repoPath)) return;
  const ignoreCase = await runGit(g, ["git", "-C", g.repoPath, "config", "--bool", "core.ignorecase"], {
    read: true,
    allowFailure: true,
  });
  if (ignoreCase.stdout.trim() !== "true") return;
  const prefix = "refs/remotes/origin/";
  const refs = await runGit(g, ["git", "-C", g.repoPath, "for-each-ref", "--format=%(refname)", prefix], { read: true });
  const want = foldName(name);
  const clash = refs.stdout
    .split("\n")
    .map((ref) => ref.slice(prefix.length))
    .find((other) => other !== "" && other !== name && foldName(other) === want);
  if (clash !== undefined) {
    throw resolveError(
      `branch '${name}' differs only in case from origin/${clash}`,
      "this filesystem ignores case in ref names, so fetching it would overwrite that ref",
    );
  }
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
 * Fetch a PR head into the worktree's FETCH_HEAD *without* updating the local
 * `pr/<n>` branch ref (§7.2). Git refuses to fetch straight into
 * `refs/heads/pr/<n>` while that branch is checked out; fetching to FETCH_HEAD
 * sidesteps that so callers can fast-forward (`refetchPr`) or hard-reset (`sync`).
 */
export async function fetchPrHead(g: GitEnv, worktreeDir: string, n: number): Promise<void> {
  g.log.step(`fetching pull/${n}`);
  const res = await runGit(
    g,
    ["git", "-C", worktreeDir, "fetch", "origin", `refs/pull/${n}/head`, "--no-tags"],
    { allowFailure: true },
  );
  if (res.code !== 0) throw classifyFetchError(res.stderr, `PR #${n}`);
}

/**
 * Re-fetch a PR on the fast path when its `pr/<n>` branch is already checked out
 * (§8.1). Fetches to FETCH_HEAD (see `fetchPrHead`) then fast-forwards the
 * worktree. A non-fast-forward (diverged / force-pushed PR) is left in place
 * with a warning — `sync` is the tool that hard-resets.
 */
export async function refetchPr(g: GitEnv, worktreeDir: string, n: number): Promise<void> {
  await fetchPrHead(g, worktreeDir, n);
  const ff = await runGit(g, ["git", "-C", worktreeDir, "merge", "--ff-only", "FETCH_HEAD"], {
    allowFailure: true,
  });
  if (!g.dryRun && ff.code !== 0) {
    g.log.warn(`pr/${n} did not fast-forward (diverged or force-pushed) — run \`sync\` to reset it`);
  }
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
function classifyFetchError(stderr: string, ref: string): TestlaneError {
  const detail = stderr.trim();
  if (
    /couldn't find remote ref|no such ref|remote ref .* not found|not our ref|unadvertised object|did not send all necessary objects/i.test(
      detail,
    )
  ) {
    return new TestlaneError("E_RESOLVE", `${ref} does not exist on origin`, {
      hint: "check the name, or push the ref first",
    });
  }
  return new TestlaneError("E_GIT", `git fetch failed for ${ref}: ${detail || "unknown error"}`);
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

// ── Repo config reads (§5.7) ─────────────────────────────────────────────────

/**
 * The bare clone's HEAD branch, e.g. `main`. A bare clone's HEAD is origin's
 * default branch at clone time, so this needs no network.
 */
export async function symbolicHead(repoPath: string): Promise<string | undefined> {
  const res = await capture(["git", "-C", repoPath, "symbolic-ref", "--short", "HEAD"], {
    allowFailure: true,
    env: env(),
  });
  const name = res.stdout.trim();
  return res.code === 0 && name !== "" ? name : undefined;
}

/** True when `ref` resolves to a commit in the local repo. */
export async function refExists(repoPath: string, ref: string): Promise<boolean> {
  const res = await capture(["git", "-C", repoPath, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    allowFailure: true,
    env: env(),
  });
  return res.code === 0;
}

export interface TreeEntry {
  mode: string;
  type: string;
  id: string;
}

/**
 * The tree entry for `path` at the root of `ref`, or null when absent. Reads
 * only tree objects, which a `blob:none` partial clone always has locally.
 */
export async function treeEntry(repoPath: string, ref: string, path: string): Promise<TreeEntry | null> {
  const res = await capture(["git", "-C", repoPath, "ls-tree", "-z", ref, "--", path], {
    allowFailure: true,
    env: env(),
    errCode: "E_GIT",
  });
  if (res.code !== 0) throw new TestlaneError("E_GIT", `git ls-tree failed for ${ref}: ${res.stderr.trim()}`);
  const line = res.stdout.split("\0")[0] ?? "";
  const m = line.match(/^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s);
  if (!m || m[4] !== path) return null;
  return { mode: m[1]!, type: m[2]!, id: m[3]! };
}

/** Largest repo file Testlane reads, in bytes (§5.7). */
export const MAX_BLOB_BYTES = 1024 * 1024;

/**
 * Read a blob's raw bytes. A partial clone fetches it from origin on demand.
 * Throws E_CONFIG for a blob over `MAX_BLOB_BYTES`, E_GIT on any git failure.
 */
export async function readBlob(repoPath: string, id: string, label: string): Promise<Buffer> {
  const run = (argv: string[]) => captureBytes(argv, { env: env() });
  const size = await run(["git", "-C", repoPath, "cat-file", "-s", id]);
  if (size.code !== 0) throw new TestlaneError("E_GIT", `cannot read ${label}: ${size.stderr.trim()}`);
  const bytes = Number(size.stdout.toString("utf8").trim());
  if (!Number.isFinite(bytes) || bytes > MAX_BLOB_BYTES) {
    throw new TestlaneError("E_CONFIG", `${label} is larger than ${MAX_BLOB_BYTES} bytes`);
  }
  const blob = await run(["git", "-C", repoPath, "cat-file", "blob", id]);
  if (blob.code !== 0) throw new TestlaneError("E_GIT", `cannot read ${label}: ${blob.stderr.trim()}`);
  return blob.stdout;
}
