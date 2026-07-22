// §17.2 scenarios 5, 6, 9 — setup.run cache, seeding, and env composition.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeEnv, makeFixtureOrigin, type Harness } from "../fixtures.ts";
import { setProcRecorder } from "../../src/lib/proc.ts";

let tmp: string;
let origin: ReturnType<typeof makeFixtureOrigin>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "uxd-setup-"));
  origin = makeFixtureOrigin(tmp);
  origin.commit("main", { "README.md": "# fixture\n" });
  origin.commit("feature-x", { "feat.txt": "hello\n" });
});

afterEach(() => {
  setProcRecorder(null);
  rmSync(tmp, { recursive: true, force: true });
});

describe("§17.2 scenario 5 — setup.run cache", () => {
  it("installs once, skips on cache hit, re-runs when a cache_key file changes", async () => {
    const env: Harness = makeEnv(tmp, {
      n8n: {
        repo: origin.url,
        defaultBranch: "main",
        extraToml: [
          "[setup]",
          'run = "echo ran >> ran.log"',
          'cache_key = ["feat.txt"]',
          "",
          "[commands.noop]",
          'run = "true"',
        ].join("\n"),
      },
    });

    const first = await env.run(["n8n", "feature-x", "run", "noop"]);
    expect(first.code).toBe(0);
    const path = join(env.worktreesPath("n8n"), "feature-x");
    expect(readFileSync(join(path, "ran.log"), "utf8").trim().split("\n").length).toBe(1);

    // Cache hit — install must not run again.
    const second = await env.run(["n8n", "feature-x", "run", "noop"]);
    expect(second.code).toBe(0);
    expect(second.stderr).toContain("cache hit");
    expect(readFileSync(join(path, "ran.log"), "utf8").trim().split("\n").length).toBe(1);

    // Change a cache_key file → the hash changes → install re-runs.
    writeFileSync(join(path, "feat.txt"), "edited\n");
    const third = await env.run(["n8n", "feature-x", "run", "noop"]);
    expect(third.code).toBe(0);
    expect(readFileSync(join(path, "ran.log"), "utf8").trim().split("\n").length).toBe(2);
  });
});

describe("§17.2 scenario 6 — seeding", () => {
  it("seeds a missing file, never overwrites, and --reseed forces it", async () => {
    const env: Harness = makeEnv(tmp, {
      n8n: {
        repo: origin.url,
        defaultBranch: "main",
        extraToml: [
          "[setup]",
          'seed_files = ["config.local"]',
          "",
          "[commands.noop]",
          'run = "true"',
        ].join("\n"),
      },
    });
    // Provide the seed source under <configDir>/seeds/<project>/.
    const seedDir = join(env.configDir, "seeds", "n8n");
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(join(seedDir, "config.local"), "SEED\n");

    const path = join(env.worktreesPath("n8n"), "feature-x");

    const first = await env.run(["n8n", "feature-x", "run", "noop"]);
    expect(first.code).toBe(0);
    expect(readFileSync(join(path, "config.local"), "utf8")).toBe("SEED\n");

    // A local edit is never clobbered by a plain re-run.
    writeFileSync(join(path, "config.local"), "EDITED\n");
    const second = await env.run(["n8n", "feature-x", "run", "noop"]);
    expect(second.code).toBe(0);
    expect(readFileSync(join(path, "config.local"), "utf8")).toBe("EDITED\n");

    // --reseed overwrites from source.
    const third = await env.run(["n8n", "feature-x", "run", "--reseed", "noop"]);
    expect(third.code).toBe(0);
    expect(readFileSync(join(path, "config.local"), "utf8")).toBe("SEED\n");
  });
});

describe("§17.2 scenario 9 — env composition (--dry-run)", () => {
  it("layers UXD_* < [env] < command env < --env, and exports UXD_PORT", async () => {
    const env: Harness = makeEnv(tmp, {
      n8n: {
        repo: origin.url,
        defaultBranch: "main",
        ports: 1,
        extraToml: [
          "[env]",
          'FOO = "project"',
          'ONLY_PROJECT = "p"',
          "",
          "[commands.dump]",
          'run = "env"',
          "",
          "[commands.dump.env]",
          'FOO = "command"',
        ].join("\n"),
      },
    });

    // --dry-run prints the export lines deterministically (no child spawn).
    const r = await env.run(["--dry-run", "n8n", "feature-x", "run", "dump", "--env", "FOO=flag"]);
    expect(r.code).toBe(0);

    const exported = new Map<string, string>();
    for (const line of r.stdout.split("\n")) {
      const m = /^export ([A-Z_0-9]+)=(.*)$/.exec(line);
      if (m) exported.set(m[1]!, m[2]!.replace(/^'(.*)'$/, "$1"));
    }
    // --env wins the FOO precedence chain.
    expect(exported.get("FOO")).toBe("flag");
    expect(exported.get("ONLY_PROJECT")).toBe("p");
    // UXD_PORT is present and non-empty.
    expect(exported.get("UXD_PORT")).toBeDefined();
    expect(exported.get("UXD_PORT")).not.toBe("");
  });
});
