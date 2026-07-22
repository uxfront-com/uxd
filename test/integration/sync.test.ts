// §17.2 scenario 4 — sync after force-push: hard reset, dirty → exit 5,
// --stash keeps changes, --fresh recreates.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeEnv, makeFixtureOrigin, type Harness } from "../fixtures.ts";
import { setProcRecorder } from "../../src/lib/proc.ts";

let tmp: string;
let origin: ReturnType<typeof makeFixtureOrigin>;
let env: Harness;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "uxd-sync-"));
  origin = makeFixtureOrigin(tmp);
  origin.commit("main", { "README.md": "# fixture\n" });
  origin.commit("feature-x", { "feat.txt": "hello\n" });
  env = makeEnv(tmp, { n8n: { repo: origin.url, defaultBranch: "main" } });
});

afterEach(() => {
  setProcRecorder(null);
  rmSync(tmp, { recursive: true, force: true });
});

function gitOut(dir: string, args: string[]): string {
  const res = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  return res.stdout.toString();
}

describe("§17.2 scenario 4 — sync", () => {
  it("hard-resets to the new tip after a force-push", async () => {
    const co = await env.run(["n8n", "feature-x", "checkout"]);
    const path = co.stdout.trim();
    expect(readFileSync(join(path, "feat.txt"), "utf8")).toBe("hello\n");

    origin.forcePush("feature-x", { "feat.txt": "changed\n" });

    const r = await env.run(["n8n", "feature-x", "sync"]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(path, "feat.txt"), "utf8")).toBe("changed\n");
  });

  it("refuses a dirty worktree with E_GIT (exit 5)", async () => {
    const co = await env.run(["n8n", "feature-x", "checkout"]);
    const path = co.stdout.trim();
    writeFileSync(join(path, "feat.txt"), "local edit\n");

    const r = await env.run(["n8n", "feature-x", "sync"]);
    expect(r.code).toBe(5);
    expect(r.stderr).toContain("error(E_GIT)");
    expect(r.stderr).toContain("uncommitted");
  });

  it("--stash preserves local changes in a stash, then resets", async () => {
    const co = await env.run(["n8n", "feature-x", "checkout"]);
    const path = co.stdout.trim();
    origin.forcePush("feature-x", { "feat.txt": "changed\n" });
    writeFileSync(join(path, "feat.txt"), "local edit\n");

    const r = await env.run(["n8n", "feature-x", "sync", "--stash"]);
    expect(r.code).toBe(0);
    // Worktree reset to the new tip; the edit is parked in a stash.
    expect(readFileSync(join(path, "feat.txt"), "utf8")).toBe("changed\n");
    expect(gitOut(path, ["stash", "list"]).trim()).not.toBe("");
  });

  it("--discard drops local changes and resets", async () => {
    const co = await env.run(["n8n", "feature-x", "checkout"]);
    const path = co.stdout.trim();
    origin.forcePush("feature-x", { "feat.txt": "changed\n" });
    writeFileSync(join(path, "feat.txt"), "local edit\n");

    const r = await env.run(["n8n", "feature-x", "sync", "--discard"]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(path, "feat.txt"), "utf8")).toBe("changed\n");
    expect(gitOut(path, ["stash", "list"]).trim()).toBe("");
  });

  it("--fresh removes and re-materializes the workspace", async () => {
    const co = await env.run(["n8n", "feature-x", "checkout"]);
    const path = co.stdout.trim();

    const r = await env.run(["n8n", "feature-x", "sync", "--fresh"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("recreated feature-x");
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(path, "feat.txt"))).toBe(true);
    expect(gitOut(path, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("refuses --fresh on a dirty worktree", async () => {
    const co = await env.run(["n8n", "feature-x", "checkout"]);
    const path = co.stdout.trim();
    writeFileSync(join(path, "feat.txt"), "local edit\n");

    const r = await env.run(["n8n", "feature-x", "sync", "--fresh"]);
    expect(r.code).toBe(5);
    expect(r.stderr).toContain("error(E_GIT)");
  });
});
