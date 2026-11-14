import { describe, expect, it } from "vitest";
import {
  collisionSlug,
  coordsEqual,
  isValidBranchName,
  normalizeRepoUrl,
  parseRef,
  parseUrlInput,
  refFromDisambiguator,
  slug,
} from "../../src/core/resolve.ts";
import { fetchBranchArgv } from "../../src/git/repo.ts";

describe("parseRef — §6.1 table", () => {
  it("'-' → last", () => expect(parseRef("-")).toEqual({ kind: "last" }));
  it("absolute path", () => expect(parseRef("/tmp/x")).toEqual({ kind: "path", path: "/tmp/x" }));
  it("./ path", () => expect(parseRef("./x")).toEqual({ kind: "path", path: "./x" }));
  it("~ path", () => expect(parseRef("~/x")).toEqual({ kind: "path", path: "~/x" }));
  it("bare number → pr", () => expect(parseRef("19234")).toEqual({ kind: "pr", number: 19234 }));
  it("#number → pr", () => expect(parseRef("#42")).toEqual({ kind: "pr", number: 42 }));
  it("pr/<n> → pr", () => expect(parseRef("pr/7")).toEqual({ kind: "pr", number: 7 }));
  it("PR/<n> case-insensitive", () => expect(parseRef("PR/7")).toEqual({ kind: "pr", number: 7 }));
  it("40-hex → commit", () => {
    const sha = "a".repeat(40);
    expect(parseRef(sha)).toEqual({ kind: "commit", sha });
  });
  it("branch name", () => expect(parseRef("ai/fix")).toEqual({ kind: "branch", name: "ai/fix" }));
  it("short sha stays a branch (not auto-commit)", () =>
    expect(parseRef("abc123")).toEqual({ kind: "branch", name: "abc123" }));
  it("garbage throws E_RESOLVE", () => expect(() => parseRef("bad..name")).toThrow(/could not parse/));
});

describe("isValidBranchName", () => {
  it("rejects empty/@", () => {
    expect(isValidBranchName("")).toBe(false);
    expect(isValidBranchName("@")).toBe(false);
  });
  it("rejects leading/trailing slash & dot", () => {
    expect(isValidBranchName("/x")).toBe(false);
    expect(isValidBranchName("x/")).toBe(false);
    expect(isValidBranchName(".x")).toBe(false);
    expect(isValidBranchName("x.")).toBe(false);
  });
  it("rejects .., //, @{, .lock, spaces, control chars", () => {
    expect(isValidBranchName("a..b")).toBe(false);
    expect(isValidBranchName("a//b")).toBe(false);
    expect(isValidBranchName("a@{b")).toBe(false);
    expect(isValidBranchName("a.lock")).toBe(false);
    expect(isValidBranchName("a b")).toBe(false);
    expect(isValidBranchName("a~b")).toBe(false);
  });
  it("accepts normal names", () => {
    expect(isValidBranchName("main")).toBe(true);
    expect(isValidBranchName("feature/x-y_z")).toBe(true);
  });
});

describe("slug — §6.3 sanitization / truncation / collision", () => {
  it("pr slug", () => expect(slug({ kind: "pr", number: 19234 })).toBe("pr-19234"));
  it("commit slug (first 10)", () =>
    expect(slug({ kind: "commit", sha: "0123456789abcdef" + "0".repeat(24) })).toBe("sha-0123456789"));
  it("branch slug sanitizes", () =>
    expect(slug({ kind: "branch", name: "Feature/Fix Canvas" })).toBe("feature-fix-canvas"));
  it("branch slug truncates long names with hash", () => {
    const long = "a".repeat(80);
    const s = slug({ kind: "branch", name: long });
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s).toMatch(/^a{52}-[0-9a-f]{7}$/);
  });
  it("collisionSlug appends deterministic hash", () => {
    const a = collisionSlug("ai/fix");
    const b = collisionSlug("ai/fix");
    expect(a).toBe(b);
    expect(a).toMatch(/-[0-9a-f]{7}$/);
  });
  it("path slug is adopted-<base>-<hash>", () => {
    const s = slug({ kind: "path", path: "/tmp/wt-3" });
    expect(s).toMatch(/^adopted-wt-3-[0-9a-f]{7}$/);
  });
});

describe("URL normalization & extraction — §4.3", () => {
  it("ssh and https normalize equal", () => {
    const a = normalizeRepoUrl("git@github.com:n8n-io/n8n.git");
    const b = normalizeRepoUrl("https://github.com/n8n-io/n8n");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(coordsEqual(a!, b!)).toBe(true);
  });
  it("extracts PR from /pull/<n>", () => {
    const u = parseUrlInput("https://github.com/n8n-io/n8n/pull/19234");
    expect(u?.ref).toEqual({ kind: "pr", number: 19234 });
  });
  it("extracts branch from /tree/<branch>", () => {
    const u = parseUrlInput("https://github.com/n8n-io/n8n/tree/ai/fix-canvas-drag");
    expect(u?.ref).toEqual({ kind: "branch", name: "ai/fix-canvas-drag" });
  });
  it("non-url returns null", () => expect(normalizeRepoUrl("not a url")).toBeNull());
});

describe("a ref can't start with '-' (it would reach git as an option)", () => {
  const attack = "--upload-pack=touch${IFS}/tmp/x;git-upload-pack";

  it("C7 — isValidBranchName rejects a leading '-'", () => {
    expect(isValidBranchName("-x")).toBe(false);
    expect(isValidBranchName(attack)).toBe(false);
    expect(isValidBranchName("x-y")).toBe(true);
  });

  it("C7 — parseRef rejects it with E_RESOLVE", () => {
    expect(() => parseRef(attack)).toThrow(/could not parse ref/);
    // `-` alone stays the last-used ref.
    expect(parseRef("-")).toEqual({ kind: "last" });
  });

  it("C7 — --branch rejects it with E_RESOLVE", () => {
    expect(() => refFromDisambiguator("branch", "--upload-pack=touch /tmp/x; git-upload-pack")).toThrow(
      /--branch expects a branch name/,
    );
    expect(refFromDisambiguator("branch", "feat/x")).toEqual({ kind: "branch", name: "feat/x" });
  });
});

describe("branch disambiguator: no refspec through a branch name", () => {
  it("C11 — refFromDisambiguator refuses refspec syntax with E_RESOLVE", () => {
    for (const bad of ["+refs/pull/7/head:refs/remotes/origin/main", "a:b", "+x", "x^", "x*", "-x"]) {
      expect(() => refFromDisambiguator("branch", bad), bad).toThrow(/--branch expects a branch name/);
      try {
        refFromDisambiguator("branch", bad);
      } catch (e) {
        expect((e as { errCode?: string }).errCode, bad).toBe("E_RESOLVE");
      }
    }
  });

  it("C11 — refFromDisambiguator accepts ordinary branch names", () => {
    for (const ok of ["feature/x", "123", "release-1.2"]) {
      expect(refFromDisambiguator("branch", ok)).toEqual({ kind: "branch", name: ok });
    }
  });

  it("C11 — a plain ref starting with '+' is refused", () => {
    expect(isValidBranchName("+x")).toBe(false);
    expect(() => parseRef("+x")).toThrow(/could not parse ref/);
  });

  it("C11 — fetchBranchArgv refuses a refspec and spells out the one it fetches", () => {
    expect(() => fetchBranchArgv("/r", "+refs/pull/7/head:refs/remotes/origin/main")).toThrow(/not a valid branch name/);
    expect(() => fetchBranchArgv("/r", "+x")).toThrow(/not a valid branch name/);
    expect(fetchBranchArgv("/r", "feature/x")).toEqual([
      "git",
      "-C",
      "/r",
      "fetch",
      "--no-tags",
      "origin",
      "--end-of-options",
      "+refs/heads/feature/x:refs/remotes/origin/feature/x",
    ]);
  });
});

describe("branch disambiguator: HEAD is not a branch name", () => {
  it("C11 — HEAD is refused everywhere a branch name reaches git fetch", () => {
    expect(isValidBranchName("HEAD")).toBe(false);
    expect(() => parseRef("HEAD")).toThrow(/could not parse ref/);
    expect(() => refFromDisambiguator("branch", "HEAD")).toThrow(/--branch expects a branch name/);
    expect(() => fetchBranchArgv("/r", "HEAD")).toThrow(/not a valid branch name/);
    expect(parseUrlInput("https://github.com/acme/app/tree/HEAD")?.ref).toBeUndefined();
    // Only the exact name: these stay ordinary branches.
    // Any case: on a case-insensitive filesystem `head` is the same file as `HEAD`.
    for (const bad of ["head", "Head", "hEaD"]) {
      expect(isValidBranchName(bad), bad).toBe(false);
      expect(() => refFromDisambiguator("branch", bad), bad).toThrow(/--branch expects a branch name/);
    }
    for (const ok of ["HEADS", "heads", "feature/HEAD", "HEAD-x"]) expect(isValidBranchName(ok), ok).toBe(true);
  });
});
