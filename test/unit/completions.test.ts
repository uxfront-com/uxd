import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { completions } from "../../src/commands/completions.ts";
import { unavailableGh } from "../../src/main.ts";
import { Logger } from "../../src/lib/log.ts";
import type { Ctx, GlobalFlags } from "../../src/config/schema.ts";

let tmp: string;
let configDir: string;

function ctxWith(configDirPath: string): Ctx {
  const flags: GlobalFlags = { dryRun: false, json: false, quiet: true, verbose: false, yes: false, noColor: true };
  return {
    configDir: configDirPath,
    defaults: {},
    flags,
    log: new Logger({ quiet: true, verbose: false, color: false }),
    gh: unavailableGh,
  };
}

/** Capture stdout across a single completions() call. */
async function emit(args: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await completions({ ctx: ctxWith(configDir), args });
    return { code, out };
  } finally {
    process.stdout.write = orig;
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "uxd-comp-"));
  configDir = join(tmp, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "n8n.toml"), 'repo = "git@github.com:n8n-io/n8n.git"\nrepo_path = "/tmp/r"\nworktrees_path = "/tmp/w"\n');
  writeFileSync(join(configDir, "styleframe.toml"), 'repo = "git@github.com:styleframe/styleframe.git"\nrepo_path = "/tmp/r2"\nworktrees_path = "/tmp/w2"\n');
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("completions §9.13", () => {
  it("bash script bakes in top verbs and project names", async () => {
    const { code, out } = await emit(["bash"]);
    expect(code).toBe(0);
    expect(out).toContain("complete -F _uxd uxd");
    expect(out).toContain("projects doctor config completions help version");
    expect(out).toContain("n8n styleframe");
    // dynamic slug completion shells out to `uxd <project> list --json`
    expect(out).toContain("list --json");
  });

  it("zsh script is compdef-tagged and lists project verbs", async () => {
    const { out } = await emit(["zsh"]);
    expect(out).toContain("#compdef uxd");
    expect(out).toContain("checkout code run exec shell sync diff info rm");
    expect(out).toContain("projects=(n8n styleframe)");
  });

  it("fish script emits a per-project completion rule", async () => {
    const { out } = await emit(["fish"]);
    expect(out).toContain("complete -c uxd");
    expect(out).toContain("-a 'n8n'");
    expect(out).toContain("__fish_uxd_slugs");
  });

  it("missing shell → E_USAGE (exit 2)", async () => {
    await expect(emit([])).rejects.toThrow(/requires a shell/);
  });

  it("unsupported shell → E_USAGE (exit 2)", async () => {
    await expect(emit(["powershell"])).rejects.toThrow(/unsupported shell/);
  });
});
