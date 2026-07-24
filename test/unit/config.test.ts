import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  ConfigValidationError,
  deriveBasePort,
  isValidProjectName,
  loadDefaults,
  loadProject,
  validateAll,
} from "../../src/config/load.ts";
import { defaultConfigDir } from "../../src/lib/paths.ts";
import { defaultProjectTemplate } from "../../src/lib/project-template.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "uxd-cfg-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, body: string) => writeFileSync(join(dir, name), body);

describe("loadProject — valid fixture → ProjectConfig", () => {
  it("resolves explicit paths and defaults", () => {
    write("defaults.toml", `editor = "zed"\n`);
    write(
      "n8n.toml",
      [
        `repo = "git@github.com:n8n-io/n8n.git"`,
        `repo_path = "/srv/n8n/repo"`,
        `worktrees_path = "/srv/n8n/trees"`,
        `default_branch = "master"`,
        `ports = 2`,
        `[commands.dev]`,
        `run = "pnpm dev"`,
      ].join("\n"),
    );
    const p = loadProject(dir, "n8n", loadDefaults(dir));
    expect(p.name).toBe("n8n");
    expect(p.repo).toBe("git@github.com:n8n-io/n8n.git");
    expect(p.repoPath).toBe("/srv/n8n/repo");
    expect(p.worktreesPath).toBe("/srv/n8n/trees");
    expect(p.defaultBranch).toBe("master");
    expect(p.editor).toBe("zed"); // from defaults
    expect(p.ports).toBe(2);
    expect(p.basePort).toBe(deriveBasePort("n8n")); // derived
    expect(p.commands.dev).toEqual({ run: "pnpm dev", cwd: undefined, env: {} });
    expect(p.defaultCommand).toBe("code"); // fallback
  });

  it("derives paths from defaults.root when project omits them", () => {
    write("defaults.toml", `root = "/data/uxd"\n`);
    write("app.toml", `repo = "git@github.com:x/app.git"\n`);
    const p = loadProject(dir, "app", loadDefaults(dir));
    expect(p.repoPath).toBe("/data/uxd/app/repo");
    expect(p.worktreesPath).toBe("/data/uxd/app/trees");
  });
});

describe("loadProject — invalid fixtures → aggregate errors", () => {
  it("missing repo (schema) fails E_CONFIG", () => {
    write("bad.toml", `ports = 2\n`);
    try {
      loadProject(dir, "bad", {});
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigValidationError);
      const err = e as ConfigValidationError;
      expect(err.errCode).toBe("E_CONFIG");
      expect(err.issues.some((i) => i.path === "repo")).toBe(true);
    }
  });

  it("unknown key rejected by strict schema", () => {
    write("bad.toml", `repo = "x"\nrepo_path = "/r"\nworktrees_path = "/t"\nnope = 1\n`);
    expect(() => loadProject(dir, "bad", {})).toThrow(ConfigValidationError);
  });

  it("missing paths without defaults.root aggregates two issues", () => {
    write("bad.toml", `repo = "x"\n`);
    try {
      loadProject(dir, "bad", {});
      throw new Error("expected throw");
    } catch (e) {
      const err = e as ConfigValidationError;
      const paths = err.issues.map((i) => i.path);
      expect(paths).toContain("repo_path");
      expect(paths).toContain("worktrees_path");
    }
  });

  it("worktrees_path inside repo_path is rejected", () => {
    write("bad.toml", `repo = "x"\nrepo_path = "/srv/app"\nworktrees_path = "/srv/app/trees"\n`);
    try {
      loadProject(dir, "bad", {});
      throw new Error("expected throw");
    } catch (e) {
      const err = e as ConfigValidationError;
      expect(err.issues.some((i) => i.path === "worktrees_path")).toBe(true);
    }
  });

  it("seed_files with .. is rejected", () => {
    write(
      "bad.toml",
      `repo = "x"\nrepo_path = "/r"\nworktrees_path = "/t"\n[setup]\nseed_files = ["../secret"]\n`,
    );
    try {
      loadProject(dir, "bad", {});
      throw new Error("expected throw");
    } catch (e) {
      const err = e as ConfigValidationError;
      expect(err.issues.some((i) => i.path === "setup.seed_files.0")).toBe(true);
    }
  });

  it("unknown default_command is rejected", () => {
    write(
      "bad.toml",
      `repo = "x"\nrepo_path = "/r"\nworktrees_path = "/t"\ndefault_command = "frobnicate"\n`,
    );
    expect(() => loadProject(dir, "bad", {})).toThrow(/unknown command 'frobnicate'/);
  });
});

describe("validateAll & defaults", () => {
  it("collects issues across all projects", () => {
    write("good.toml", `repo = "x"\nrepo_path = "/r"\nworktrees_path = "/t"\n`);
    write("bad.toml", `ports = 2\n`);
    const issues = validateAll(dir);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => typeof i.message === "string")).toBe(true);
  });

  it("empty config dir yields no issues", () => {
    expect(validateAll(dir)).toEqual([]);
  });

  it("loadDefaults returns {} when absent", () => {
    expect(loadDefaults(dir)).toEqual({});
  });

  it("deriveBasePort is in [3000, 6900] on the 100-step grid", () => {
    const bp = deriveBasePort("n8n");
    expect(bp).toBeGreaterThanOrEqual(3000);
    expect(bp).toBeLessThanOrEqual(6900);
    expect((bp - 3000) % 100).toBe(0);
  });
});

describe("defaultProjectTemplate — §9.12 seed", () => {
  it("leaves only `repo` uncommented; every other line is a comment (AC5)", () => {
    const lines = defaultProjectTemplate("acme")
      .split("\n")
      .filter((l) => l.trim() !== "");
    const active = lines.filter((l) => !l.trimStart().startsWith("#"));
    expect(active).toEqual([`repo = "git@github.com:ORG/REPO.git"   # required`]);
  });

  it("validates clean after replacing the placeholder repo, deriving paths from root (AC5/AC6)", () => {
    write("defaults.toml", `root = "/data/uxd"\n`);
    const seeded = defaultProjectTemplate("acme").replace(
      "git@github.com:ORG/REPO.git",
      "git@github.com:acme/app.git",
    );
    write("acme.toml", seeded);
    const p = loadProject(dir, "acme", loadDefaults(dir));
    expect(p.repo).toBe("git@github.com:acme/app.git");
    // Paths are not hardcoded in the template; they derive from defaults.root (AC6).
    expect(p.repoPath).toBe("/data/uxd/acme/repo");
    expect(p.worktreesPath).toBe("/data/uxd/acme/trees");
  });

  it("interpolates the project name into the header comment", () => {
    expect(defaultProjectTemplate("my-proj")).toContain("uxd config validate my-proj");
  });
});

describe("isValidProjectName — §5.1 guard", () => {
  it("accepts legal names and rejects reserved / malformed ones (AC3)", () => {
    expect(isValidProjectName("n8n")).toBe(true);
    expect(isValidProjectName("my-proj.v2")).toBe(true);
    expect(isValidProjectName("defaults")).toBe(false);
    expect(isValidProjectName("seeds")).toBe(false);
    expect(isValidProjectName("Bad_Name")).toBe(false);
    expect(isValidProjectName("-leading")).toBe(false);
    expect(isValidProjectName("../escape")).toBe(false);
  });
});

describe("defaultConfigDir — §5.1", () => {
  it("defaults to ~/.uxd (no XDG fallback)", () => {
    expect(defaultConfigDir()).toBe(join(homedir(), ".uxd"));
  });
});
