// `uxd setup` — onboarding: create the config dir + scaffold the first project.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main, unavailableGh } from "../../src/main.ts";

let tmp: string;
let configDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "uxd-setup-cmd-"));
  // A path that does NOT exist yet — setup must create it.
  configDir = join(tmp, "config");
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run main() in-process with output captured; gh is never spawned. */
async function run(argv: string[]): Promise<RunResult> {
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
  try {
    const code = await main(["--config-dir", configDir, ...argv], { gh: unavailableGh });
    return { code, stdout: out, stderr: err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

describe("uxd setup", () => {
  it("creates the config dir, seeds defaults.root, and scaffolds a valid project", async () => {
    const root = join(tmp, "root");
    const r = await run([
      "setup",
      "--name",
      "n8n",
      "--repo",
      "git@github.com:n8n-io/n8n.git",
      "--root",
      root,
      "--default-branch",
      "master",
    ]);
    expect(r.code).toBe(0);

    expect(existsSync(configDir)).toBe(true);

    const defaults = readFileSync(join(configDir, "defaults.toml"), "utf8");
    expect(defaults).toContain(`root = "${root}"`);

    const project = readFileSync(join(configDir, "n8n.toml"), "utf8");
    expect(project).toContain('repo = "git@github.com:n8n-io/n8n.git"');
    expect(project).toContain('default_branch = "master"');

    // The scaffolded project is immediately discoverable and loads cleanly.
    const list = await run(["--json", "projects"]);
    expect(list.code).toBe(0);
    const rows = JSON.parse(list.stdout) as Array<{ name: string; repo: string }>;
    expect(rows.map((x) => x.name)).toContain("n8n");

    // And `config validate` agrees the written file is valid.
    const valid = await run(["config", "validate", "n8n"]);
    expect(valid.code).toBe(0);
  });

  it("omits default_branch when none is given", async () => {
    const r = await run(["setup", "--name", "app", "--repo", "https://example.com/app.git", "--root", join(tmp, "root")]);
    expect(r.code).toBe(0);
    const project = readFileSync(join(configDir, "app.toml"), "utf8");
    expect(project).toContain('repo = "https://example.com/app.git"');
    expect(project).not.toContain("default_branch");
  });

  it("--dry-run writes nothing", async () => {
    const r = await run(["--dry-run", "setup", "--name", "app", "--repo", "https://example.com/app.git", "--root", join(tmp, "root")]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`mkdir -p ${configDir}`);
    expect(r.stdout).toContain("app.toml");
    expect(existsSync(configDir)).toBe(false);
  });

  it("refuses to clobber an existing project without --force", async () => {
    const root = join(tmp, "root");
    const first = await run(["setup", "--name", "app", "--repo", "https://example.com/a.git", "--root", root]);
    expect(first.code).toBe(0);

    const second = await run(["setup", "--name", "app", "--repo", "https://example.com/b.git"]);
    expect(second.code).not.toBe(0);
    expect(second.stderr).toContain("already exists");

    // The original file is untouched.
    expect(readFileSync(join(configDir, "app.toml"), "utf8")).toContain("https://example.com/a.git");

    // --force overwrites.
    const forced = await run(["setup", "--name", "app", "--repo", "https://example.com/b.git", "--force"]);
    expect(forced.code).toBe(0);
    expect(readFileSync(join(configDir, "app.toml"), "utf8")).toContain("https://example.com/b.git");
  });

  it("rejects an invalid project name (E_USAGE, nothing written)", async () => {
    const r = await run(["setup", "--name", "Bad Name", "--repo", "https://example.com/a.git", "--root", join(tmp, "root")]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid project name");
    expect(existsSync(join(configDir, "Bad Name.toml"))).toBe(false);
  });

  it("errors when a required value is missing on a non-TTY", async () => {
    // No --repo and stdin is not a TTY under vitest → targeted usage error.
    const r = await run(["setup", "--name", "app", "--root", join(tmp, "root")]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("repository URL");
    expect(existsSync(join(configDir, "app.toml"))).toBe(false);
  });
});
