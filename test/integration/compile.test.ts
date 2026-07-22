// Guards the `bun build --compile` standalone binary. The compile entry must
// keep a `.ts` extension: an extensionless entry compiles to a binary that runs
// but emits nothing (loader/shebang mishandling), so `version`/`help` printed
// empty output from the compiled CLI while the interpreted source worked. We
// compile the real binary and assert piped output survives.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = join(import.meta.dir, "..", "..");
let dir: string;
let binPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "uxd-compile-"));
  binPath = join(dir, "uxd");
  const build = Bun.spawnSync(
    ["bun", "build", join(repoRoot, "bin", "uxd.ts"), "--compile", "--outfile", binPath],
    { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
  );
  if (build.exitCode !== 0) {
    throw new Error(`compile failed: ${build.stderr.toString()}`);
  }
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the compiled binary with stdout captured through a pipe (non-TTY). */
function runBin(args: string[]): { code: number; stdout: string } {
  const r = Bun.spawnSync([binPath, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, stdout: r.stdout.toString() };
}

describe("compiled binary — piped stdout is not truncated", () => {
  it("`version` prints to a pipe and exits 0", () => {
    const r = runBin(["version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("uxd ");
  });

  it("`help` prints its full usage text to a pipe", () => {
    const r = runBin(["help"]);
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(100);
    expect(r.stdout).toContain("PROJECT VERBS");
  });
});
