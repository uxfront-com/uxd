import { describe, expect, it } from "vitest";
import { parse, type ParseDeps } from "../../src/cli/parse.ts";
import { parseUrlInput } from "../../src/core/resolve.ts";

const deps: ParseDeps = {
  projectExists: (n) => n === "my-project" || n === "styleframe",
  knownProjects: () => ["my-project", "styleframe"],
  projectCommandNames: (p) => (p === "my-project" ? ["dev", "test"] : []),
  projectDefaultCommand: () => "code",
  resolveUrlProject: (url) => {
    const parsed = parseUrlInput(url);
    if (parsed && parsed.coords.owner === "my-org" && parsed.coords.repo === "my-project") {
      return { project: "my-project", ref: parsed.ref };
    }
    return null;
  },
};

const p = (argv: string[]) => parse(argv, deps);

describe("parse — §4.4 canonical examples", () => {
  it("bare PR → default_command (code)", () => {
    const r = p(["my-project", "19234"]);
    expect(r.kind).toBe("workspace");
    if (r.kind !== "workspace") return;
    expect(r.project).toBe("my-project");
    expect(r.ref).toEqual({ kind: "pr", number: 19234 });
    expect(r.verb).toBe("code");
  });

  it("explicit code verb", () => {
    const r = p(["my-project", "19234", "code"]);
    expect(r.kind === "workspace" && r.verb).toBe("code");
  });

  it("pr/<n> run dev", () => {
    const r = p(["my-project", "pr/19234", "run", "dev"]);
    expect(r.kind).toBe("workspace");
    if (r.kind !== "workspace") return;
    expect(r.ref).toEqual({ kind: "pr", number: 19234 });
    expect(r.verb).toBe("run");
    expect(r.args).toEqual(["dev"]);
  });

  it("#<n> shell", () => {
    const r = p(["my-project", "#19234", "shell"]);
    expect(r.kind).toBe("workspace");
    if (r.kind !== "workspace") return;
    expect(r.ref).toEqual({ kind: "pr", number: 19234 });
    expect(r.verb).toBe("shell");
  });

  it("branch checkout", () => {
    const r = p(["my-project", "ai/fix-canvas-drag", "checkout"]);
    expect(r.kind).toBe("workspace");
    if (r.kind !== "workspace") return;
    expect(r.ref).toEqual({ kind: "branch", name: "ai/fix-canvas-drag" });
    expect(r.verb).toBe("checkout");
  });

  it("command-name sugar → run", () => {
    const r = p(["my-project", "ai/fix-canvas-drag", "dev"]);
    expect(r.kind).toBe("workspace");
    if (r.kind !== "workspace") return;
    expect(r.verb).toBe("run");
    expect(r.commandName).toBe("dev");
    expect(r.args).toEqual(["dev"]);
  });

  it("last-used ref '-'", () => {
    const r = p(["my-project", "-", "run", "test"]);
    expect(r.kind).toBe("workspace");
    if (r.kind !== "workspace") return;
    expect(r.ref).toEqual({ kind: "last" });
    expect(r.verb).toBe("run");
    expect(r.args).toEqual(["test"]);
  });

  it("adopt path ref", () => {
    const r = p(["my-project", "~/agents/wt-3", "run", "test"]);
    expect(r.kind).toBe("workspace");
    if (r.kind !== "workspace") return;
    expect(r.ref).toEqual({ kind: "path", path: "~/agents/wt-3" });
  });

  it("URL form — PR", () => {
    const r = p(["https://github.com/my-org/my-project/pull/19234", "code"]);
    expect(r.kind).toBe("workspace");
    if (r.kind !== "workspace") return;
    expect(r.project).toBe("my-project");
    expect(r.ref).toEqual({ kind: "pr", number: 19234 });
    expect(r.verb).toBe("code");
  });

  it("URL form — tree/branch", () => {
    const r = p(["https://github.com/my-org/my-project/tree/ai/fix-canvas-drag", "diff"]);
    expect(r.kind).toBe("workspace");
    if (r.kind !== "workspace") return;
    expect(r.ref).toEqual({ kind: "branch", name: "ai/fix-canvas-drag" });
    expect(r.verb).toBe("diff");
  });

  it("exec with passthrough", () => {
    const r = p(["my-project", "19234", "exec", "--", "pnpm", "why", "lodash"]);
    expect(r.kind).toBe("workspace");
    if (r.kind !== "workspace") return;
    expect(r.verb).toBe("exec");
    expect(r.passthrough).toEqual(["pnpm", "why", "lodash"]);
  });

  it("run dev with passthrough appended", () => {
    const r = p(["my-project", "19234", "run", "dev", "--", "--host", "0.0.0.0"]);
    expect(r.kind).toBe("workspace");
    if (r.kind !== "workspace") return;
    expect(r.verb).toBe("run");
    expect(r.args).toEqual(["dev"]);
    expect(r.passthrough).toEqual(["--host", "0.0.0.0"]);
  });

  it("list --json", () => {
    const r = p(["my-project", "list", "--json"]);
    expect(r.kind).toBe("project");
    if (r.kind !== "project") return;
    expect(r.verb).toBe("list");
    expect(r.global.json).toBe(true);
  });

  it("bare project → list", () => {
    const r = p(["my-project"]);
    expect(r.kind).toBe("project");
    if (r.kind !== "project") return;
    expect(r.verb).toBe("list");
  });

  it("sync --fresh", () => {
    const r = p(["my-project", "19234", "sync", "--fresh"]);
    expect(r.kind === "workspace" && r.verb).toBe("sync");
    if (r.kind === "workspace") expect(r.args).toEqual(["--fresh"]);
  });

  it("top-level projects / doctor", () => {
    expect(p(["projects"]).kind).toBe("top");
    const d = p(["doctor"]);
    expect(d.kind === "top" && d.verb).toBe("doctor");
  });

  it("config edit my-project", () => {
    const r = p(["config", "edit", "my-project"]);
    expect(r.kind).toBe("top");
    if (r.kind !== "top") return;
    expect(r.verb).toBe("config");
    expect(r.args).toEqual(["edit", "my-project"]);
  });

  it("no args → help", () => {
    const r = p([]);
    expect(r.kind === "top" && r.verb).toBe("help");
  });
});

describe("parse — global flags & disambiguators", () => {
  it("--dry-run anywhere before verb", () => {
    const r = p(["--dry-run", "my-project", "19234", "checkout"]);
    expect(r.global.dryRun).toBe(true);
  });

  it("--branch forces a numeric branch name", () => {
    const r = p(["my-project", "--branch", "1234", "code"]);
    expect(r.kind).toBe("workspace");
    if (r.kind !== "workspace") return;
    expect(r.ref).toEqual({ kind: "branch", name: "1234" });
    expect(r.verb).toBe("code");
  });

  it("--pr forces PR interpretation", () => {
    const r = p(["my-project", "--pr", "42", "shell"]);
    expect(r.kind === "workspace" && r.ref).toEqual({ kind: "pr", number: 42 });
  });
});

describe("parse — error cases", () => {
  it("unknown project throws (exit 3)", () => {
    expect(() => p(["nope", "19234"])).toThrow(/unknown project/);
  });

  it("unknown command throws (exit 2)", () => {
    expect(() => p(["my-project", "main", "frobnicate"])).toThrow(/unknown command/);
  });

  it("flag before command throws", () => {
    expect(() => p(["--nope", "my-project"])).toThrow(/unexpected flag/);
  });

  it("URL with no matching project throws (exit 4)", () => {
    expect(() => p(["https://github.com/other/repo/pull/1", "code"])).toThrow(/no configured project/);
  });

  it("two disambiguators throw", () => {
    expect(() => p(["my-project", "--pr", "1", "--branch", "x", "code"])).toThrow(/only one ref disambiguator/);
  });
});
