// §17.2 scenarios 7 & 8 — clean --merged (git-only) and adopted path refs.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeEnv, makeFixtureOrigin, type Harness } from "../fixtures.ts";
import { setProcRecorder } from "../../src/lib/proc.ts";

let tmp: string;
let origin: ReturnType<typeof makeFixtureOrigin>;
let env: Harness;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "uxd-clean-"));
  origin = makeFixtureOrigin(tmp);
  origin.commit("main", { "README.md": "# fixture\n" });
  origin.commit("feature-x", { "feat.txt": "hello\n" });
  env = makeEnv(tmp, { n8n: { repo: origin.url, defaultBranch: "main" } });
});

afterEach(() => {
  setProcRecorder(null);
  rmSync(tmp, { recursive: true, force: true });
});

function state(): { workspaces: Record<string, { slug: string; adopted?: boolean }> } {
  const file = join(env.stateHome, "uxd", "n8n.json");
  return JSON.parse(readFileSync(file, "utf8"));
}

function branchExists(name: string): boolean {
  const res = Bun.spawnSync(
    ["git", "-C", env.repoPath("n8n"), "rev-parse", "--verify", `refs/heads/${name}`],
    { stdout: "pipe", stderr: "pipe" },
  );
  return res.exitCode === 0;
}

describe("§17.2 scenario 7 — clean --merged", () => {
  it("plans and removes a merged PR workspace: worktree, branch, data, state", async () => {
    origin.makePr(50, "feature-x");
    const co = await env.run(["n8n", "50", "checkout"]);
    expect(co.code).toBe(0);
    const path = co.stdout.trim();
    const dataDir = join(env.worktreesPath("n8n"), ".data", "pr-50");
    expect(existsSync(path)).toBe(true);
    expect(branchExists("pr/50")).toBe(true);

    // Merge the PR head into the default branch on origin.
    origin.merge("main", "feature-x");

    const r = await env.run(["n8n", "clean", "--merged", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("pr-50");
    expect(r.stderr).toContain("merged");

    expect(existsSync(path)).toBe(false);
    expect(existsSync(dataDir)).toBe(false);
    expect(branchExists("pr/50")).toBe(false);
    expect(state().workspaces["pr-50"]).toBeUndefined();
  });

  it("reports nothing to remove when no branch is merged", async () => {
    await env.run(["n8n", "feature-x", "checkout"]);
    const r = await env.run(["n8n", "clean", "--merged", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("nothing to remove");
    expect(state().workspaces["feature-x"]).toBeDefined();
  });
});

describe("§17.2 scenario 8 — adopted path ref", () => {
  it("runs commands in the adopted dir and rm leaves the directory", async () => {
    // A real git working tree outside uxd's worktrees.
    const adopted = join(tmp, "external");
    mkdirSync(adopted, { recursive: true });
    const g = (args: string[]) =>
      Bun.spawnSync(["git", "-C", adopted, "-c", "user.email=t@t.local", "-c", "user.name=t", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
    g(["init", "-b", "main"]);
    writeFileSync(join(adopted, "a.txt"), "x\n");
    g(["add", "-A"]);
    g(["commit", "-m", "init"]);

    // exec runs in the adopted dir; the touch proves the cwd.
    const r = await env.run(["n8n", "--path", adopted, "exec", "--", "touch", "marker"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(adopted, "marker"))).toBe(true);

    const s = state();
    const entry = Object.values(s.workspaces).find((w) => w.adopted);
    expect(entry).toBeDefined();

    // rm removes the workspace record but never the adopted directory.
    const slug = entry!.slug;
    const rm = await env.run(["n8n", "--path", adopted, "rm", "--yes"]);
    expect(rm.code).toBe(0);
    expect(existsSync(adopted)).toBe(true);
    expect(existsSync(join(adopted, "marker"))).toBe(true);
    expect(state().workspaces[slug]).toBeUndefined();
  });
});
