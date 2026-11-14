// §5.7 — the repo file's schema split and the merge rules.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigValidationError, loadDefaults, loadProject, loadProjectWithSources } from "../../src/config/load.ts";
import { mergeRaw, parseRepoConfig } from "../../src/config/repo.ts";
import { USER_ONLY_KEYS } from "../../src/config/schema.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "testlane-repocfg-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, body: string) => writeFileSync(join(dir, name), body);

function issuesOf(fn: () => unknown): ConfigValidationError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigValidationError) return e;
    throw e;
  }
  throw new Error("expected a ConfigValidationError");
}

const USER_ONLY_SAMPLES: Record<(typeof USER_ONLY_KEYS)[number], string> = {
  repo: `repo = "git@github.com:acme/app.git"`,
  repo_path: `repo_path = "/tmp/repo"`,
  worktrees_path: `worktrees_path = "/tmp/trees"`,
  default_branch: `default_branch = "main"`,
  editor: `editor = "zed"`,
  base_port: `base_port = 5000`,
  "setup.seed_from": `[setup]\nseed_from = "~/dev/app"`,
};

describe("repo schema", () => {
  it.each(USER_ONLY_KEYS.map((k) => [k]))("rejects the user-only key %s", (key) => {
    const err = issuesOf(() => parseRepoConfig("app", USER_ONLY_SAMPLES[key]));
    expect(err.issues).toHaveLength(1);
    expect(err.issues[0]).toEqual({ file: "app:.testlane.toml", path: key, message: "user-only key; set it in app.toml" });
    expect(err.message).toBe(`app:.testlane.toml: ${key}: user-only key; set it in app.toml`);
  });

  it("reports two bad keys as two issues in one error", () => {
    const err = issuesOf(() => parseRepoConfig("app", `editor = "zed"\nports = "two"\n`));
    expect(err.errCode).toBe("E_CONFIG");
    expect(err.issues.map((i) => i.path).sort()).toEqual(["editor", "ports"]);
    for (const issue of err.issues) expect(issue.file).toBe("app:.testlane.toml");
    expect(err.message.split("\n")).toHaveLength(2);
  });

  it("rejects an unknown key and a bad hook name like the project file does", () => {
    const err = issuesOf(() => parseRepoConfig("app", `nope = 1\n[hooks]\npost_merge = "x"\n`));
    expect(err.issues.map((i) => i.path).sort()).toEqual(["(root)", "hooks"]);
  });

  it("labels a TOML syntax error with the repo file", () => {
    const err = issuesOf(() => parseRepoConfig("app", `ports = = 1`));
    expect(err.issues[0]!.file).toBe("app:.testlane.toml");
    expect(err.issues[0]!.message).toMatch(/^TOML parse error/);
  });

  it("parses a file with every allowed key", () => {
    const raw = parseRepoConfig(
      "app",
      [
        `ports = 2`,
        `default_command = "dev"`,
        `[setup]`,
        `run = "pnpm install"`,
        `cache_key = ["pnpm-lock.yaml"]`,
        `seed_files = [".env.local"]`,
        `[env]`,
        `PORT = "{port}"`,
        `[commands.dev]`,
        `run = "pnpm dev"`,
        `cwd = "web"`,
        `[commands.dev.env]`,
        `DEBUG = "1"`,
        `[hooks]`,
        `post_checkout = "echo hi"`,
        `pre_run = "true"`,
        `post_sync = "true"`,
        `pre_clean = "true"`,
      ].join("\n"),
    );
    expect(raw.ports).toBe(2);
    expect(raw.commands?.dev).toEqual({ run: "pnpm dev", cwd: "web", env: { DEBUG: "1" } });
    expect(raw.setup).toEqual({ run: "pnpm install", cache_key: ["pnpm-lock.yaml"], seed_files: [".env.local"] });
    expect(Object.keys(raw.hooks ?? {})).toHaveLength(4);
  });

  it("accepts an empty file", () => {
    expect(parseRepoConfig("app", "")).toEqual({});
  });
});

describe("merge", () => {
  const user = { repo: "git@github.com:acme/app.git" };

  it("scalars: the user value replaces the repo value", () => {
    const { raw, sources } = mergeRaw(
      { ...user, ports: 3, default_command: "checkout", setup: { run: "user install" } },
      { ports: 2, default_command: "dev", setup: { run: "repo install" } },
    );
    expect(raw.ports).toBe(3);
    expect(raw.default_command).toBe("checkout");
    expect(raw.setup?.run).toBe("user install");
    expect(sources).toMatchObject({ ports: "user", default_command: "user", "setup.run": "user" });
  });

  it("scalars: the repo value applies when the user leaves it unset", () => {
    const { raw, sources } = mergeRaw(user, { ports: 2, setup: { run: "repo install" } });
    expect(raw.ports).toBe(2);
    expect(raw.setup?.run).toBe("repo install");
    expect(sources).toMatchObject({ ports: "repo", "setup.run": "repo", repo: "user" });
  });

  it("env merges by key", () => {
    const { raw, sources } = mergeRaw({ ...user, env: { A: "user", C: "user" } }, { env: { A: "repo", B: "repo" } });
    expect(raw.env).toEqual({ A: "user", B: "repo", C: "user" });
    expect(sources).toMatchObject({ "env.A": "user", "env.B": "repo", "env.C": "user" });
  });

  it("commands merge by key, and a user command replaces the whole repo command", () => {
    const { raw, sources } = mergeRaw(
      { ...user, commands: { dev: { run: "user dev" } } },
      {
        commands: {
          dev: { run: "repo dev", cwd: "web", env: { X: "1" } },
          test: { run: "repo test" },
        },
      },
    );
    expect(raw.commands).toEqual({ dev: { run: "user dev" }, test: { run: "repo test" } });
    expect(raw.commands?.dev?.cwd).toBeUndefined();
    expect(raw.commands?.dev?.env).toBeUndefined();
    expect(sources).toMatchObject({ "commands.dev": "user", "commands.test": "repo" });
  });

  it("arrays are replaced, not concatenated", () => {
    const { raw } = mergeRaw(
      { ...user, setup: { cache_key: ["user.lock"], seed_files: [".env.user"] } },
      { setup: { cache_key: ["repo.lock", "x"], seed_files: [".env.repo"] } },
    );
    expect(raw.setup?.cache_key).toEqual(["user.lock"]);
    expect(raw.setup?.seed_files).toEqual([".env.user"]);
  });

  it("an empty user array still replaces the repo array", () => {
    const { raw } = mergeRaw({ ...user, setup: { cache_key: [] } }, { setup: { cache_key: ["repo.lock"] } });
    expect(raw.setup?.cache_key).toEqual([]);
  });

  it("hooks merge per hook name", () => {
    const { raw, sources } = mergeRaw(
      { ...user, hooks: { pre_run: "user pre" } },
      { hooks: { pre_run: "repo pre", post_checkout: "repo post" } },
    );
    expect(raw.hooks).toEqual({ pre_run: "user pre", post_checkout: "repo post" });
    expect(sources).toMatchObject({ "hooks.pre_run": "user", "hooks.post_checkout": "repo" });
  });

  it("no repo layer leaves the user file as it is", () => {
    const u = { ...user, ports: 2, env: { A: "1" }, setup: { seed_from: "~/x" } };
    expect(mergeRaw(u).raw).toEqual(u);
  });

  it("precedence: a repo default_command beats defaults.toml, and a user one beats both", () => {
    write("defaults.toml", `root = "/data/testlane"\ndefault_command = "checkout"\n`);
    write("app.toml", `repo = "git@github.com:acme/app.git"\n`);
    const defaults = loadDefaults(dir);
    const layer = parseRepoConfig("app", `default_command = "dev"\n[commands.dev]\nrun = "pnpm dev"\n`);

    expect(loadProject(dir, "app", defaults).defaultCommand).toBe("checkout");
    expect(loadProject(dir, "app", defaults, layer).defaultCommand).toBe("dev");

    write("app.toml", `repo = "git@github.com:acme/app.git"\ndefault_command = "code"\n`);
    expect(loadProject(dir, "app", defaults, layer).defaultCommand).toBe("code");
  });

  it("a user default_command may name a repo command", () => {
    write("app.toml", `repo = "x"\nrepo_path = "/r"\nworktrees_path = "/t"\ndefault_command = "dev"\n`);
    expect(() => loadProject(dir, "app", {})).toThrow(ConfigValidationError);
    const layer = parseRepoConfig("app", `[commands.dev]\nrun = "pnpm dev"\n`);
    expect(loadProject(dir, "app", {}, layer).defaultCommand).toBe("dev");
  });

  it("labels a semantic issue with the file its key came from", () => {
    write("app.toml", `repo = "x"\nrepo_path = "/r"\nworktrees_path = "/t"\n`);
    const layer = parseRepoConfig("app", `default_command = "nope"\n[setup]\nseed_files = ["../escape"]\n`);
    const err = issuesOf(() => loadProject(dir, "app", {}, layer));
    expect(err.issues.map((i) => `${i.file}: ${i.path}`).sort()).toEqual([
      "app:.testlane.toml: default_command",
      "app:.testlane.toml: setup.seed_files.0",
    ]);
  });

  it("records sources per key, defaults included", () => {
    write("defaults.toml", `root = "/data/testlane"\n`);
    write("app.toml", `repo = "x"\n[env]\nA = "1"\n`);
    const layer = parseRepoConfig("app", `[commands.which]\nrun = "echo"\n[env]\nB = "2"\n`);
    const { sources } = loadProjectWithSources(dir, "app", loadDefaults(dir), layer);
    expect(sources).toMatchObject({
      repo: "user",
      editor: "default",
      repo_path: "default",
      ports: "default",
      default_command: "default",
      "setup.cache_key": "default",
      "setup.seed_files": "default",
      "commands.which": "repo",
      "env.A": "user",
      "env.B": "repo",
    });
  });
});

describe("validateAll and approved snapshots", () => {
  it("reads snapshots only when asked, and reports an unusable one by its label", async () => {
    const { validateAll } = await import("../../src/config/load.ts");
    const prev = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(dir, "state");
    try {
      write("app.toml", `repo = "x"\nrepo_path = "/r"\nworktrees_path = "/t"\n`);
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(dir, "state", "testlane"), { recursive: true });
      const content = `editor = "zed"\n`;
      const sha256 = (await import("node:crypto")).createHash("sha256").update(content).digest("hex");
      writeFileSync(
        join(dir, "state", "testlane", "app.json"),
        JSON.stringify({ version: 1, workspaces: {}, repoConfig: { sha256, blob: "b", content, approvedAt: "x" } }),
      );
      expect(validateAll(dir)).toEqual([]);
      expect(validateAll(dir, { snapshots: true })).toEqual([
        { file: "app:.testlane.toml", path: "editor", message: "user-only key; set it in app.toml" },
      ]);
    } finally {
      if (prev === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prev;
    }
  });
});
