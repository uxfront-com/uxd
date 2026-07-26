import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PKG_NAME, version } from "../../src/cli/help.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string;
  version: string;
};

describe("version — resolved from uxd's own package.json", () => {
  // Regression: the lookup matched the name "uxd" while the manifest says
  // "@uxfront/uxd", so every run fell through to the "0.0.0" fallback.
  it("matches the name declared in package.json", () => {
    expect(PKG_NAME).toBe(pkg.name);
  });

  it("returns the version from package.json, not the fallback", () => {
    expect(version()).toBe(pkg.version);
    expect(version()).not.toBe("0.0.0");
  });
});
