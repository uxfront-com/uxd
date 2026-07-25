// M2 integration coverage: commit refs (§6.1), list --json shape + doctor fix
// hint (§17.2 scenario 12), gh-driven list/diff/clean paths via a fake gh
// client, and clean --prune-state (§9.9).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeEnv, makeFixtureOrigin, fakeGh, type Harness } from "../fixtures.ts";
import { setProcRecorder } from "../../src/lib/proc.ts";
import type { GhClient } from "../../src/git/gh.ts";

let tmp: string;
let origin: ReturnType<typeof makeFixtureOrigin>;
let env: Harness;

beforeEach(() => {
  // realpath: on macOS $TMPDIR is a symlink (/var → /private/var) and git prints
  // resolved worktree paths, which would not compare equal to the config paths.
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "uxd-m2-")));
  origin = makeFixtureOrigin(tmp);
  origin.commit("main", { "README.md": "# fixture\n" });
  origin.commit("feature-x", { "feat.txt": "hello\n" });
  env = makeEnv(tmp, { n8n: { repo: origin.url, defaultBranch: "main" } });
});

afterEach(() => {
  setProcRecorder(null);
  rmSync(tmp, { recursive: true, force: true });
});

function state(): { workspaces: Record<string, { slug: string; kind: string; branch?: string }> } {
  return JSON.parse(readFileSync(join(env.stateHome, "uxd", "n8n.json"), "utf8"));
}

function headSha(dir: string): string {
  return spawnSync("git", ["-C", dir, "rev-parse", "HEAD"]).stdout.toString().trim();
}

/**
 * A second harness over the *same* tmp (so it reuses the already-cloned bare
 * repo and worktrees) but whose `repo` is a GitHub-style URL. Git operations
 * still hit the local bare repo via its stored origin; only gh slug derivation
 * (`ghRepoSlug`) reads `repo`, which is what enables the gh-driven code paths.
 */
function ghEnv(gh: GhClient): Harness {
  return makeEnv(tmp, { n8n: { repo: "git@github.com:acme/app.git", defaultBranch: "main" } }, { gh });
}

async function checkoutPr(n: number, branch: string): Promise<void> {
  origin.makePr(n, branch);
  const r = await env.run(["n8n", String(n), "checkout"]);
  expect(r.code).toBe(0);
}

describe("§6.1 commit ref", () => {
  it("checks out a full SHA as a detached worktree with a sha- slug", async () => {
    const sha = origin.commit("commit-src", { "c.txt": "payload\n" });
    const r = await env.run(["n8n", sha, "checkout"]);
    expect(r.code).toBe(0);

    const slug = `sha-${sha.slice(0, 10)}`;
    const expectedPath = join(env.worktreesPath("n8n"), slug);
    expect(r.stdout.trim()).toBe(expectedPath);
    expect(existsSync(join(expectedPath, "c.txt"))).toBe(true);

    const s = state();
    expect(s.workspaces[slug]?.kind).toBe("commit");
    expect(s.workspaces[slug]?.branch).toBeUndefined();

    // HEAD is detached exactly at the requested commit.
    const head = spawnSync("git", ["-C", expectedPath, "rev-parse", "HEAD"])
      .stdout.toString()
      .trim();
    expect(head).toBe(sha);
  });
});

describe("§17.2 scenario 12 — list --json shape & doctor fix hint", () => {
  it("list --json emits a stripped array of workspace records", async () => {
    await env.run(["n8n", "feature-x", "checkout"]);
    const r = await env.run(["n8n", "list", "--json"]);
    expect(r.code).toBe(0);

    const rows = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
    expect(Array.isArray(rows)).toBe(true);
    const row = rows.find((x) => x.slug === "feature-x");
    expect(row).toBeDefined();
    expect(row!.kind).toBe("branch");
    expect(row!.branch).toBe("feature-x");
    expect(Array.isArray(row!.ports)).toBe(true);
    // diskBytes is a --du-only field; absent from the default JSON.
    expect(row).not.toHaveProperty("diskBytes");
  });

  it("doctor on a repo with a deleted fetch refspec fails with the fix hint", async () => {
    await env.run(["n8n", "feature-x", "checkout"]); // clones + configures the bare repo
    const unset = spawnSync(
      "git",
      ["-C", env.repoPath("n8n"), "config", "--unset-all", "remote.origin.fetch"],
    );
    expect(unset.status).toBe(0);

    const r = await env.run(["--json", "doctor"]);
    expect(r.code).not.toBe(0);
    const report = JSON.parse(r.stdout) as {
      ok: boolean;
      checks: Array<{ name: string; status: string; detail: string }>;
    };
    expect(report.ok).toBe(false);
    const check = report.checks.find((c) => c.name.includes("fetch refspec"));
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("config");
    expect(check?.detail).toContain("remote.origin.fetch");
  });

  it("doctor warns about a hand-deleted worktree git has not pruned yet", async () => {
    await env.run(["n8n", "feature-x", "checkout"]);
    const wt = join(env.worktreesPath("n8n"), "feature-x");
    expect(existsSync(wt)).toBe(true);
    rmSync(wt, { recursive: true, force: true });
    // git still lists the worktree until `git worktree prune` runs — that is the
    // exact drift the disk check exists to catch.
    const listed = spawnSync("git", ["-C", env.repoPath("n8n"), "worktree", "list"]).stdout.toString();
    expect(listed).toContain(wt);

    const r = await env.run(["--json", "doctor"]);
    const report = JSON.parse(r.stdout) as { checks: Array<{ name: string; status: string; detail: string }> };
    const check = report.checks.find((c) => c.name.includes("worktrees"));
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("1 state entry");
    expect(check?.detail).toContain("clean --prune-state");
  });

  it("doctor reports a healthy tree with no worktree drift", async () => {
    await env.run(["n8n", "feature-x", "checkout"]);
    const r = await env.run(["--json", "doctor"]);
    const report = JSON.parse(r.stdout) as { checks: Array<{ name: string }> };
    expect(report.checks.find((c) => c.name.includes("worktrees"))).toBeUndefined();
  });

  it("doctor resolves an absolute editor binary and names it consistently", async () => {
    const e = makeEnv(tmp, { term: { repo: origin.url, extraToml: 'editor = "terminal"' } });
    const prev = process.env.SHELL;
    try {
      // The `terminal` preset resolves to $SHELL, always an absolute path.
      process.env.SHELL = process.execPath;
      let report = JSON.parse((await e.run(["--json", "doctor"])).stdout) as Report;
      let check = report.checks.find((c) => c.name === "project term: editor");
      expect(check?.status).toBe("ok");
      expect(check?.detail).toContain(process.execPath);

      process.env.SHELL = join(tmp, "no-such-shell");
      report = JSON.parse((await e.run(["--json", "doctor"])).stdout) as Report;
      check = report.checks.find((c) => c.name === "project term: editor");
      expect(check?.status).toBe("warn");
      // Both halves of the message must name the same binary — never a hardcoded 'code'.
      expect(check?.detail).toContain(join(tmp, "no-such-shell"));
      expect(check?.detail).not.toContain("code");
    } finally {
      if (prev === undefined) delete process.env.SHELL;
      else process.env.SHELL = prev;
    }
  });
});

interface Report {
  checks: Array<{ name: string; status: string; detail: string }>;
}

describe("gh-driven paths (fake gh client)", () => {
  it("list surfaces PR state + CI from a fresh gh view", async () => {
    await checkoutPr(42, "feature-x");
    const r = await ghEnv(fakeGh({ 42: { state: "OPEN", ci: "pass" } })).run(["n8n", "list"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("open");
    expect(r.stdout).toContain("✓");
  });

  it("diff on a PR delegates to gh pr diff", async () => {
    await checkoutPr(43, "feature-x");
    const gh = fakeGh({ 43: { state: "OPEN" } });
    const r = await ghEnv(gh).run(["n8n", "43", "diff"]);
    expect(r.code).toBe(0);
    expect(gh.diffCalls).toHaveLength(1);
    expect(gh.diffCalls[0]).toEqual({ n: 43, args: [] });
  });

  it("diff --stat on a PR falls back to the git path (gh pr diff has no --stat)", async () => {
    await checkoutPr(45, "feature-x");
    const gh = fakeGh({ 45: { state: "OPEN" } });
    const r = await ghEnv(gh).run(["--dry-run", "n8n", "45", "diff", "--stat"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("git -C");
    expect(r.stdout).toContain("--stat");
    expect(r.stdout).not.toContain("gh pr diff");
    expect(gh.diffCalls).toHaveLength(0);
  });

  it("diff with git-only passthrough args on a PR uses the git path", async () => {
    await checkoutPr(46, "feature-x");
    const gh = fakeGh({ 46: { state: "OPEN" } });
    const r = await ghEnv(gh).run(["--dry-run", "n8n", "46", "diff", "--", "--color-words"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--color-words");
    expect(r.stdout).not.toContain("gh pr diff");
    expect(gh.diffCalls).toHaveLength(0);
  });

  it("clean --closed removes a PR whose gh state is CLOSED", async () => {
    await checkoutPr(44, "feature-x");
    const r = await ghEnv(fakeGh({ 44: { state: "CLOSED" } })).run(["n8n", "clean", "--closed", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("pr-44");
    expect(r.stderr).toContain("closed");
    expect(state().workspaces["pr-44"]).toBeUndefined();
  });
});

describe("§9.7 diff — git path", () => {
  it("dry-run diff on a branch prints a local git diff invocation", async () => {
    const co = await env.run(["n8n", "feature-x", "checkout"]);
    const path = co.stdout.trim();
    const r = await env.run(["--dry-run", "n8n", "feature-x", "diff"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("git -C");
    expect(r.stdout).toContain(path);
    expect(r.stdout).toContain("diff");
  });
});

describe("§8.1 PR re-fetch into a checked-out branch", () => {
  it("checkout --fetch fast-forwards the pr/<n> worktree without erroring", async () => {
    origin.makePr(70, "feature-x");
    const co = await env.run(["n8n", "70", "checkout"]);
    expect(co.code).toBe(0);
    const path = co.stdout.trim();
    const before = headSha(path);

    // A new commit lands on the PR head upstream.
    origin.commit("feature-x", { "feat.txt": "hello again\n" });
    origin.makePr(70, "feature-x");

    const r = await env.run(["n8n", "70", "checkout", "--fetch"]);
    expect(r.code).toBe(0); // regression: previously exit 5 (refusing to fetch into checked-out branch)
    expect(headSha(path)).not.toBe(before);
    expect(readFileSync(join(path, "feat.txt"), "utf8")).toBe("hello again\n");
  });

  it("sync hard-resets a PR workspace to the latest head", async () => {
    origin.makePr(71, "feature-x");
    const co = await env.run(["n8n", "71", "checkout"]);
    expect(co.code).toBe(0);
    const path = co.stdout.trim();
    const before = headSha(path);

    origin.commit("feature-x", { "feat.txt": "v2\n" });
    origin.makePr(71, "feature-x");

    const r = await env.run(["n8n", "71", "sync"]);
    expect(r.code).toBe(0);
    expect(headSha(path)).not.toBe(before);
    expect(readFileSync(join(path, "feat.txt"), "utf8")).toBe("v2\n");
  });
});

describe("§9.12 config add alias", () => {
  it("`config add` resolves identically to `config edit`", async () => {
    const add = await env.run(["--dry-run", "config", "add", "n8n"]);
    const edit = await env.run(["--dry-run", "config", "edit", "n8n"]);
    expect(add.code).toBe(0);
    expect(add.stdout.trim().length).toBeGreaterThan(0);
    expect(add.stdout).toContain("n8n.toml");
    expect(add.stdout).toBe(edit.stdout); // same editor launch argv
  });

  it("an unknown subcommand still lists add in the hint", async () => {
    const r = await env.run(["config", "frobnicate"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("path | edit | add | validate");
  });
});

describe("§9.12 config add — seed a template when the project is absent", () => {
  // A no-op "editor" so non-dry-run runs write the file, then exit 0 without
  // launching a real editor (which would inherit stdin and hang the test).
  let prevEditor: string | undefined;
  beforeEach(() => {
    prevEditor = process.env.EDITOR;
    process.env.EDITOR = "true";
  });
  afterEach(() => {
    if (prevEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = prevEditor;
  });

  it("AC1 — seeds the default template and warns for an absent file", async () => {
    const r = await env.run(["config", "add", "fresh"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("creating new project file");
    const file = join(env.configDir, "fresh.toml");
    expect(existsSync(file)).toBe(true);
    const body = readFileSync(file, "utf8");
    expect(body).toContain(`repo = "git@github.com:ORG/REPO.git"`);
    expect(body).toContain("uxd config validate fresh");
  });

  it("AC2 — never seeds or warns for an existing file", async () => {
    const file = join(env.configDir, "n8n.toml"); // seeded by the harness
    const before = readFileSync(file, "utf8");
    // --dry-run avoids launching n8n's configured editor; the seed branch is
    // still exercised and must be skipped because the file already exists.
    const r = await env.run(["--dry-run", "config", "add", "n8n"]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("creating new project file");
    expect(r.stdout).not.toContain(`repo = "git@github.com:ORG/REPO.git"`); // no template emitted
    expect(readFileSync(file, "utf8")).toBe(before); // file untouched
  });

  it("AC3 — refuses a reserved or malformed name and writes nothing", async () => {
    const reserved = await env.run(["config", "add", "defaults"]);
    expect(reserved.code).toBe(2);
    expect(reserved.stderr).toContain("invalid project name");
    expect(existsSync(join(env.configDir, "defaults.toml"))).toBe(false);

    const malformed = await env.run(["config", "add", "Bad_Name"]);
    expect(malformed.code).toBe(2);
    expect(existsSync(join(env.configDir, "Bad_Name.toml"))).toBe(false);
  });

  it("AC4 — --dry-run prints the template and editor argv but writes no file", async () => {
    process.env.EDITOR = "vim"; // a path-bearing preset (never spawned under --dry-run)
    const r = await env.run(["--dry-run", "config", "add", "ghost"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`repo = "git@github.com:ORG/REPO.git"`); // the template
    expect(r.stdout).toContain("ghost.toml"); // the editor argv target
    expect(existsSync(join(env.configDir, "ghost.toml"))).toBe(false);
  });

  it("AC5/AC6 — a seeded file validates once the placeholder repo is real", async () => {
    const seed = await env.run(["config", "add", "acme"]);
    expect(seed.code).toBe(0);

    const file = join(env.configDir, "acme.toml");
    const edited = readFileSync(file, "utf8").replace("git@github.com:ORG/REPO.git", origin.url);
    writeFileSync(file, edited);
    // Paths are omitted from the template; they resolve from defaults.root (AC6).
    writeFileSync(join(env.configDir, "defaults.toml"), `root = ${JSON.stringify(join(tmp, "root"))}\n`);

    const v = await env.run(["config", "validate", "acme"]);
    expect(v.code).toBe(0);
    expect(v.stderr).toContain("acme: ok");
  });
});

describe("§9.9 clean --prune-state", () => {
  it("removes state entries whose worktree directory is gone", async () => {
    const co = await env.run(["n8n", "feature-x", "checkout"]);
    const path = co.stdout.trim();
    expect(existsSync(path)).toBe(true);

    // Simulate an out-of-band worktree deletion.
    rmSync(path, { recursive: true, force: true });

    const r = await env.run(["n8n", "clean", "--prune-state", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("feature-x");
    expect(r.stderr).toContain("state-only");
    expect(state().workspaces["feature-x"]).toBeUndefined();
  });
});
