import { describe, expect, it } from "vitest";
import { interpolate, workspaceVars } from "../../src/lib/template.ts";

const vars = workspaceVars({
  path: "/w/ai-fix",
  repoPath: "/repo",
  dataDir: "/data/ai-fix",
  project: "n8n",
  ref: "ai/fix",
  branch: "ai/fix",
  slug: "ai-fix",
  ports: [5100, 5101, 5102],
});

describe("interpolate — §5.5 single-pass", () => {
  it("substitutes all known vars", () => {
    expect(interpolate("{project}:{slug}@{path}", vars, "x")).toBe("n8n:ai-fix@/w/ai-fix");
    expect(interpolate("{repo_path}/{branch}", vars, "x")).toBe("/repo/ai/fix");
    expect(interpolate("{data_dir}|{ref}", vars, "x")).toBe("/data/ai-fix|ai/fix");
  });

  it("{port} is the first port; {port+N} within bounds", () => {
    expect(interpolate("{port}", vars, "x")).toBe("5100");
    expect(interpolate("{port+1}", vars, "x")).toBe("5101");
    expect(interpolate("{port+2}", vars, "x")).toBe("5102");
  });

  it("{port+N} out of range is an unknown var", () => {
    expect(() => interpolate("{port+3}", vars, "cmd.run")).toThrow(/unknown template variable/);
  });

  it("{{ escapes a literal brace", () => {
    expect(interpolate("{{port}", vars, "x")).toBe("{port}");
    expect(interpolate("a{{b", vars, "x")).toBe("a{b");
  });

  it("unknown var throws E_CONFIG pointing at field", () => {
    expect(() => interpolate("{nope}", vars, "commands.dev.run")).toThrow(/commands\.dev\.run: unknown template variable '\{nope\}'/);
  });

  it("unterminated brace throws", () => {
    expect(() => interpolate("{oops", vars, "x")).toThrow(/unterminated/);
  });

  it("passes through text with no tokens", () => {
    expect(interpolate("plain text 123", vars, "x")).toBe("plain text 123");
  });
});

describe("workspaceVars — port map bounds", () => {
  it("single port yields no {port+N} keys", () => {
    const v = workspaceVars({
      path: "/w",
      repoPath: "/r",
      dataDir: "/d",
      project: "p",
      ref: "r",
      branch: "b",
      slug: "s",
      ports: [7000],
    });
    expect(v.port).toBe("7000");
    expect("port+1" in v).toBe(false);
  });

  it("empty ports yields empty {port}", () => {
    const v = workspaceVars({
      path: "/w",
      repoPath: "/r",
      dataDir: "/d",
      project: "p",
      ref: "r",
      branch: "b",
      slug: "s",
      ports: [],
    });
    expect(v.port).toBe("");
  });
});
