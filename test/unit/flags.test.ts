import { describe, expect, it } from "vitest";
import { parseFlags } from "../../src/cli/flags.ts";

describe("parseFlags — verb-local parser", () => {
  it("collects positionals and leaves flags out of them", () => {
    const f = parseFlags(["a", "--fetch", "b"], { bools: ["--fetch"] });
    expect(f.positionals).toEqual(["a", "b"]);
    expect(f.bool("--fetch")).toBe(true);
    expect(f.bool("--missing")).toBe(false);
  });

  it("treats a lone '-' as a positional, not a flag", () => {
    const f = parseFlags(["-"], {});
    expect(f.positionals).toEqual(["-"]);
  });

  it("takes a value from the next token or an inline =", () => {
    const spaced = parseFlags(["--older-than", "7d"], { values: ["--older-than"] });
    expect(spaced.value("--older-than")).toBe("7d");

    const inline = parseFlags(["--older-than=7d"], { values: ["--older-than"] });
    expect(inline.value("--older-than")).toBe("7d");
  });

  it("collects repeated multi flags in order (both forms)", () => {
    const f = parseFlags(["--env", "A=1", "--env=B=2", "--env", "C=3"], { multi: ["--env"] });
    expect(f.list("--env")).toEqual(["A=1", "B=2", "C=3"]);
  });

  it("returns an empty list for an untouched multi flag", () => {
    const f = parseFlags([], { multi: ["--env"] });
    expect(f.list("--env")).toEqual([]);
  });

  it("throws E_USAGE on an unknown flag", () => {
    expect(() => parseFlags(["--nope"], {})).toThrow();
  });

  it("throws E_USAGE when a value flag has no value", () => {
    expect(() => parseFlags(["--older-than"], { values: ["--older-than"] })).toThrow();
  });
});
