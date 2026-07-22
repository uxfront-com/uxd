// Integration-test fixtures (§17.2): a real bare-git origin + an in-process
// harness that runs main() against tmp UXD_CONFIG_DIR / XDG_STATE_HOME.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main, unavailableGh } from "../src/main.ts";
import type { GhClient, PrMeta } from "../src/git/gh.ts";

const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: "uxd-test",
  GIT_AUTHOR_EMAIL: "uxd@test.local",
  GIT_COMMITTER_NAME: "uxd-test",
  GIT_COMMITTER_EMAIL: "uxd@test.local",
} as const;

/** Run a git command synchronously; throws on non-zero with captured stderr. */
function git(args: string[], cwd?: string): string {
  const res = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, ...AUTHOR_ENV, GIT_TERMINAL_PROMPT: "0" } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString().trim()}`);
  }
  return res.stdout.toString();
}

export interface FixtureOrigin {
  /** file:// URL of the bare origin, usable as a clone source. */
  url: string;
  /** On-disk path of the bare origin. */
  path: string;
  /** Create/switch `branch`, write `files`, commit, push. Returns the sha. */
  commit(branch: string, files: Record<string, string>): string;
  /** Publish an existing branch's tip as `refs/pull/<n>/head` in the origin. */
  makePr(n: number, branch: string): void;
  /** Amend history on `branch` and force-push. Returns the new sha. */
  forcePush(branch: string, files: Record<string, string>): string;
  /** Merge `from` into `into` in the origin (via the work clone). Returns the new sha. */
  merge(into: string, from: string): string;
}

/** Build a bare origin repo plus a private work clone used to author commits. */
export function makeFixtureOrigin(tmp: string): FixtureOrigin {
  const originPath = join(tmp, "origin.git");
  const workPath = join(tmp, "work");
  mkdirSync(originPath, { recursive: true });
  git(["init", "--bare", "-b", "main", originPath]);
  // Local file:// clones use the smart protocol; allow partial (blob:none) fetch.
  git(["-C", originPath, "config", "uploadpack.allowFilter", "true"]);
  git(["-C", originPath, "config", "uploadpack.allowAnySHA1InWant", "true"]);
  git(["init", "-b", "main", workPath]);
  git(["-C", workPath, "remote", "add", "origin", originPath]);

  const author = (branch: string, files: Record<string, string>, force: boolean): string => {
    git(["-C", workPath, "checkout", "-B", branch]);
    for (const [rel, body] of Object.entries(files)) {
      writeFileSync(join(workPath, rel), body);
    }
    git(["-C", workPath, "add", "-A"]);
    git(["-C", workPath, "commit", "-m", `commit on ${branch}`]);
    git(["-C", workPath, "push", ...(force ? ["-f"] : []), "origin", branch]);
    return git(["-C", workPath, "rev-parse", "HEAD"]).trim();
  };

  return {
    url: `file://${originPath}`,
    path: originPath,
    commit: (branch, files) => author(branch, files, false),
    forcePush: (branch, files) => author(branch, files, true),
    makePr: (n, branch) => {
      const sha = git(["-C", originPath, "rev-parse", `refs/heads/${branch}`]).trim();
      git(["-C", originPath, "update-ref", `refs/pull/${n}/head`, sha]);
    },
    merge: (into, from) => {
      git(["-C", workPath, "checkout", into]);
      git(["-C", workPath, "merge", "--no-ff", "-m", `Merge ${from} into ${into}`, from]);
      git(["-C", workPath, "push", "origin", into]);
      return git(["-C", workPath, "rev-parse", "HEAD"]).trim();
    },
  };
}

export interface ProjectSpec {
  repo: string;
  defaultBranch?: string;
  ports?: number;
  extraToml?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Harness {
  configDir: string;
  stateHome: string;
  worktreesPath(project: string): string;
  repoPath(project: string): string;
  run(argv: string[]): Promise<RunResult>;
}

/**
 * Write project configs into a tmp config dir and return a `run()` that invokes
 * main() in-process with env pointed at tmp. `gh` defaults to unavailable; pass
 * a fake client to exercise the gh-driven paths (list status, diff, --closed).
 */
export function makeEnv(
  tmp: string,
  projects: Record<string, ProjectSpec>,
  opts: { gh?: GhClient } = {},
): Harness {
  const gh = opts.gh ?? unavailableGh;
  const configDir = join(tmp, "config");
  const stateHome = join(tmp, "state");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(stateHome, { recursive: true });

  const repoPath = (project: string) => join(tmp, "projects", project, "repo");
  const worktreesPath = (project: string) => join(tmp, "projects", project, "trees");

  for (const [name, spec] of Object.entries(projects)) {
    const lines = [
      `repo = ${JSON.stringify(spec.repo)}`,
      `repo_path = ${JSON.stringify(repoPath(name))}`,
      `worktrees_path = ${JSON.stringify(worktreesPath(name))}`,
      `default_branch = ${JSON.stringify(spec.defaultBranch ?? "main")}`,
    ];
    if (spec.ports !== undefined) lines.push(`ports = ${spec.ports}`);
    if (spec.extraToml) lines.push(spec.extraToml);
    writeFileSync(join(configDir, `${name}.toml`), lines.join("\n") + "\n");
  }

  const run = async (argv: string[]): Promise<RunResult> => {
    const prevConfig = process.env.UXD_CONFIG_DIR;
    const prevState = process.env.XDG_STATE_HOME;
    const prevDebug = process.env.UXD_DEBUG;
    process.env.UXD_CONFIG_DIR = configDir;
    process.env.XDG_STATE_HOME = stateHome;
    delete process.env.UXD_DEBUG;

    let out = "";
    let err = "";
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      err += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stderr.write;

    let code: number;
    try {
      code = await main(argv, { gh });
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      restore("UXD_CONFIG_DIR", prevConfig);
      restore("XDG_STATE_HOME", prevState);
      restore("UXD_DEBUG", prevDebug);
    }
    return { code, stdout: out, stderr: err };
  };

  return { configDir, stateHome, worktreesPath, repoPath, run };
}

function restore(key: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

/**
 * A deterministic in-memory GhClient for exercising the gh-driven paths without
 * spawning `gh`. `metas` maps a PR number to its metadata; `prDiff` records its
 * calls and returns exit 0.
 */
export function fakeGh(metas: Record<number, Partial<PrMeta>>): GhClient & { diffCalls: Array<{ n: number; args: string[] }> } {
  const diffCalls: Array<{ n: number; args: string[] }> = [];
  return {
    diffCalls,
    available: async () => true,
    prView: async (_repo, n) => {
      const m = metas[n];
      if (!m) return null;
      return {
        headRefName: m.headRefName ?? `pr/${n}`,
        isCrossRepository: m.isCrossRepository ?? false,
        headRepositoryOwner: m.headRepositoryOwner ?? "",
        state: m.state ?? "OPEN",
        title: m.title ?? `PR #${n}`,
        author: m.author ?? "octocat",
        url: m.url ?? `https://github.com/acme/app/pull/${n}`,
        ci: m.ci ?? null,
      };
    },
    prDiff: async (_repo, n, args) => {
      diffCalls.push({ n, args });
      return 0;
    },
  };
}
