// Packaging guard (UXF-265).
//
// `uxd setup` failed for a user with `error(E_CONFIG): unknown project 'setup'`
// while the same command worked from source. The published artifact was built
// before the verb existed, so `TOP_LEVEL_VERBS` had no "setup"; parse.ts then
// fell through step 3a to step 3c and read the verb as a project name.
//
// The whole suite runs against src/, so nothing was red. These tests exercise
// the built entrypoint instead — the thing users actually install.

import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const builtCli = join(repoRoot, "dist", "bin", "uxd.js");

// Spelled out, not imported from TOP_LEVEL_VERBS: a list derived from the table
// cannot detect a verb missing from the table.
const PROMISED_VERBS = ["setup", "projects", "doctor", "config", "completions", "help", "version"];

beforeAll(() => {
  const build = spawnSync("npx", ["tsc", "-p", "tsconfig.build.json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (build.status !== 0) {
    throw new Error(`build failed:\n${build.stdout}${build.stderr}`);
  }
}, 120_000);

/** Run the built CLI against a config dir that does not exist yet. */
function runBuilt(argv: string[]): { code: number; stdout: string; stderr: string } {
  const tmp = mkdtempSync(join(tmpdir(), "uxd-packaging-"));
  try {
    const res = spawnSync("node", [builtCli, "--config-dir", join(tmp, "config"), ...argv], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe("packaging — the built CLI ships every command", () => {
  it("emits a module for every command main() dispatches", () => {
    expect(existsSync(builtCli)).toBe(true);
    // setup.js was the file missing from the published tarball.
    expect(existsSync(join(repoRoot, "dist", "src", "commands", "setup.js"))).toBe(true);
  });

  it.each(PROMISED_VERBS)("resolves '%s' as a verb, not as a project name", (verb) => {
    const r = runBuilt([verb]);
    // The verb may still fail for its own reasons (missing config dir, missing
    // required flag). It must never be mistaken for a project.
    expect(r.stderr).not.toContain(`unknown project '${verb}'`);
  });

  it("runs `setup` end-to-end from the built entrypoint", () => {
    const r = runBuilt([
      "--dry-run",
      "setup",
      "--name",
      "demo",
      "--repo",
      "git@github.com:uxfront-com/uxd.git",
      "--root",
      "/tmp/uxd-packaging-root",
    ]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("demo.toml");
  });
});
