import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeSetupHash } from "../../src/core/setup.ts";

let tree: string;

beforeEach(() => {
  tree = mkdtempSync(join(tmpdir(), "uxd-hash-"));
});

afterEach(() => {
  rmSync(tree, { recursive: true, force: true });
});

describe("computeSetupHash — §8.4.2", () => {
  it("is stable for identical inputs", async () => {
    writeFileSync(join(tree, "package.json"), '{"name":"x"}\n');
    const a = await computeSetupHash(tree, ["package.json"]);
    const b = await computeSetupHash(tree, ["package.json"]);
    expect(a).toBe(b);
  });

  it("changes when a matched file's bytes change", async () => {
    writeFileSync(join(tree, "lock"), "v1\n");
    const before = await computeSetupHash(tree, ["lock"]);
    writeFileSync(join(tree, "lock"), "v2\n");
    const after = await computeSetupHash(tree, ["lock"]);
    expect(after).not.toBe(before);
  });

  it("excludes node_modules and .git matches", async () => {
    const base = await computeSetupHash(tree, ["**/*.js"]);
    mkdirSync(join(tree, "node_modules"), { recursive: true });
    writeFileSync(join(tree, "node_modules", "dep.js"), "noise\n");
    mkdirSync(join(tree, ".git"), { recursive: true });
    writeFileSync(join(tree, ".git", "hook.js"), "noise\n");
    const after = await computeSetupHash(tree, ["**/*.js"]);
    expect(after).toBe(base);
  });

  it("yields a stable hash for an empty glob set", async () => {
    const a = await computeSetupHash(tree, []);
    const b = await computeSetupHash(tree, []);
    expect(a).toBe(b);
    expect(a.length).toBe(64); // sha256 hex
  });
});
