import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeEnv, makeFixtureOrigin, type Harness } from "../fixtures.ts";
import { setProcRecorder } from "../../src/lib/proc.ts";
import { isBareRepo, fetchRefspecConfigured } from "../../src/git/repo.ts";

let tmp: string;
let origin: ReturnType<typeof makeFixtureOrigin>;
let env: Harness;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "uxd-it-"));
  origin = makeFixtureOrigin(tmp);
  origin.commit("main", { "README.md": "# fixture\n" });
  origin.commit("feature-x", { "feat.txt": "hello\n" });
  env = makeEnv(tmp, { "my-project": { repo: origin.url, defaultBranch: "main" } });
});

afterEach(() => {
  setProcRecorder(null);
  rmSync(tmp, { recursive: true, force: true });
});

function state(project: string): { workspaces: Record<string, { slug: string; kind: string; branch?: string }> ; lastRef?: string } {
  const file = join(env.stateHome, "uxd", `${project}.json`);
  return JSON.parse(readFileSync(file, "utf8"));
}

describe("§17.2 scenario 1 — first checkout of a branch", () => {
  it("clones bare, sets fetch refspec, worktree exists, stdout = path", async () => {
    const r = await env.run(["my-project", "feature-x", "checkout"]);
    expect(r.code).toBe(0);

    const expectedPath = join(env.worktreesPath("my-project"), "feature-x");
    expect(r.stdout.trim()).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
    expect(existsSync(join(expectedPath, "feat.txt"))).toBe(true);

    expect(existsSync(env.repoPath("my-project"))).toBe(true);
    expect(await isBareRepo(env.repoPath("my-project"))).toBe(true);
    expect(await fetchRefspecConfigured(env.repoPath("my-project"))).toBe(true);

    const s = state("my-project");
    expect(s.workspaces["feature-x"]?.kind).toBe("branch");
    expect(s.workspaces["feature-x"]?.branch).toBe("feature-x");
  });
});

describe("§17.2 scenario 2 — second checkout reuses without fetching", () => {
  it("no fetch on the fast path, same path, exit 0", async () => {
    const first = await env.run(["my-project", "feature-x", "checkout"]);
    expect(first.code).toBe(0);
    const path1 = first.stdout.trim();

    const recorded: string[][] = [];
    setProcRecorder((argv) => recorded.push(argv));
    const second = await env.run(["my-project", "feature-x", "checkout"]);
    setProcRecorder(null);

    expect(second.code).toBe(0);
    expect(second.stdout.trim()).toBe(path1);
    const ranFetch = recorded.some((argv) => argv.includes("fetch"));
    expect(ranFetch).toBe(false);
  });
});

describe("§17.2 scenario 3 — checkout of a PR ref", () => {
  it("creates pr/<n> branch, worktree, and a state entry", async () => {
    origin.makePr(42, "feature-x");
    const r = await env.run(["my-project", "42", "checkout"]);
    expect(r.code).toBe(0);

    const expectedPath = join(env.worktreesPath("my-project"), "pr-42");
    expect(r.stdout.trim()).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);

    // Local pr/42 branch materialized in the bare repo.
    const branch = spawnSync(
      "git",
      ["-C", env.repoPath("my-project"), "rev-parse", "--verify", "refs/heads/pr/42"],
    );
    expect(branch.status).toBe(0);

    const s = state("my-project");
    expect(s.workspaces["pr-42"]?.kind).toBe("pr");
    expect(s.workspaces["pr-42"]?.branch).toBe("pr/42");
  });
});

describe("§17.2 scenario 10 — --dry-run checkout on a fresh project", () => {
  it("prints the plan and creates nothing", async () => {
    const r = await env.run(["--dry-run", "my-project", "feature-x", "checkout"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("git clone --bare");
    expect(r.stdout).toContain("fetch");
    expect(r.stdout).toContain("worktree add");

    // Nothing materialized on disk.
    expect(existsSync(env.repoPath("my-project"))).toBe(false);
    expect(existsSync(join(env.worktreesPath("my-project"), "feature-x"))).toBe(false);
    expect(existsSync(join(env.stateHome, "uxd", "my-project.json"))).toBe(false);
  });
});

describe("§17.2 scenario 11 — lock contention", () => {
  it("two concurrent checkouts serialize; both succeed", async () => {
    origin.commit("feature-y", { "y.txt": "y\n" });
    const [a, b] = await Promise.all([
      env.run(["my-project", "feature-x", "checkout"]),
      env.run(["my-project", "feature-y", "checkout"]),
    ]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(existsSync(join(env.worktreesPath("my-project"), "feature-x"))).toBe(true);
    expect(existsSync(join(env.worktreesPath("my-project"), "feature-y"))).toBe(true);
  });

  it("steals a stale lock held by a dead pid", async () => {
    // Seed the primary repo first so the stolen-lock run does real work.
    await env.run(["my-project", "feature-x", "checkout"]);

    const lockFile = join(env.stateHome, "uxd", "my-project.lock");
    writeFileSync(lockFile, JSON.stringify({ pid: 2_147_483_646, startedAt: new Date().toISOString() }));

    origin.commit("feature-z", { "z.txt": "z\n" });
    const r = await env.run(["my-project", "feature-z", "checkout"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("stealing stale lock");
    expect(existsSync(join(env.worktreesPath("my-project"), "feature-z"))).toBe(true);
  });
});

describe("error contract (§14)", () => {
  it("a ref absent on origin → E_RESOLVE (exit 4), not E_GIT", async () => {
    const r = await env.run(["my-project", "definitely-no-such-branch", "checkout"]);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("error(E_RESOLVE)");
    expect(r.stderr).toContain("does not exist on origin");
  });

  it("an absent PR ref on origin → E_RESOLVE (exit 4)", async () => {
    const r = await env.run(["my-project", "999999", "checkout"]);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("error(E_RESOLVE)");
  });
});
