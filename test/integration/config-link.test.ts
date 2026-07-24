// `config link <name> --from <path>` scaffolds a pointer that `extends` a
// repo-committed config, then validates the merged result (§5.4.1, §9.12).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeEnv, type Harness } from "../fixtures.ts";

let tmp: string;
let env: Harness;
let basePath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "uxd-link-"));
  env = makeEnv(tmp, {}); // empty config dir; we link projects in
  const repoDir = join(tmp, "clone");
  mkdirSync(repoDir, { recursive: true });
  basePath = join(repoDir, ".uxd.toml");
  writeFileSync(
    basePath,
    [
      `repo = "git@github.com:acme/app.git"`,
      `repo_path = "${join(tmp, "app", "repo")}"`,
      `worktrees_path = "${join(tmp, "app", "trees")}"`,
      `ports = 2`,
      `[commands.dev]`,
      `run = "pnpm dev"`,
    ].join("\n") + "\n",
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("config link", () => {
  it("writes a pointer file and the merged config validates", async () => {
    const linked = await env.run(["config", "link", "app", "--from", basePath]);
    expect(linked.code).toBe(0);

    const pointer = join(env.configDir, "app.toml");
    expect(existsSync(pointer)).toBe(true);
    expect(readFileSync(pointer, "utf8")).toContain(`extends = "${basePath}"`);

    const validated = await env.run(["config", "validate", "app"]);
    expect(validated.code).toBe(0);

    // The project is discoverable and reports the repo from the base file.
    const projects = await env.run(["projects", "--json"]);
    expect(projects.code).toBe(0);
    expect(projects.stdout).toContain("git@github.com:acme/app.git");
  });

  it("--dry-run prints the pointer without writing it", async () => {
    const res = await env.run(["config", "link", "app", "--from", basePath, "--dry-run"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(`extends = "${basePath}"`);
    expect(existsSync(join(env.configDir, "app.toml"))).toBe(false);
  });

  it("refuses to clobber an existing project without --force", async () => {
    writeFileSync(join(env.configDir, "app.toml"), `repo = "x"\nrepo_path = "/r"\nworktrees_path = "/t"\n`);
    const res = await env.run(["config", "link", "app", "--from", basePath]);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/already exists/);
  });

  it("fails when the referenced config is missing", async () => {
    const res = await env.run(["config", "link", "app", "--from", join(tmp, "clone", "nope.toml")]);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/not found/);
  });
});
