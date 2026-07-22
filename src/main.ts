// Entry point: config-dir resolution, parse, dispatch, error formatting (§4, §14).

import { existsSync } from "node:fs";
import { ExitCode, UxdError, isUxdError } from "./lib/errors.ts";
import { Logger, colorEnabled } from "./lib/log.ts";
import { defaultConfigDir } from "./lib/paths.ts";
import { parse, type ParseDeps, type ParseResult } from "./cli/parse.ts";
import {
  listProjectNames,
  loadDefaults,
  loadProject,
  projectExists,
} from "./config/load.ts";
import {
  coordsEqual,
  normalizeRepoUrl,
  parseUrlInput,
  type RefSpec,
} from "./core/resolve.ts";
import { RealGhClient, unavailableGh, type GhClient } from "./git/gh.ts";
import type { Ctx, Defaults, ProjectConfig } from "./config/schema.ts";

import { HELP, version } from "./cli/help.ts";
import { checkout } from "./commands/checkout.ts";
import { code } from "./commands/code.ts";
import { list, info, pick } from "./commands/list.ts";
import { clean, rm } from "./commands/clean.ts";
import { projects } from "./commands/projects.ts";
import { doctor } from "./commands/doctor.ts";
import { config } from "./commands/config.ts";
import { run, exec, shell } from "./commands/process.ts";
import { sync } from "./commands/sync.ts";
import { diff } from "./commands/diff.ts";
import { completions } from "./commands/completions.ts";

export interface MainOptions {
  /** Injectable GitHub client; tests pass `unavailableGh` so gh is never spawned. */
  gh?: GhClient;
}

export async function main(argv: string[], opts: MainOptions = {}): Promise<number> {
  const debug = wantsDebug(argv);
  try {
    const configDir = resolveConfigDir(argv);
    const defaults = loadDefaults(configDir);
    const deps = buildDeps(configDir, defaults);

    const result = parse(argv, deps);

    guardConfigDir(result, configDir);

    const flags = result.global;
    const log = new Logger({
      quiet: flags.quiet,
      verbose: flags.verbose,
      color: colorEnabled(flags.noColor),
    });
    const gh = opts.gh ?? new RealGhClient();
    const ctx: Ctx = { configDir, defaults, flags, log, gh };

    return await dispatch(result, ctx, defaults);
  } catch (e) {
    return formatError(e, debug);
  }
}

// ── Config-dir resolution (§5.1) ────────────────────────────────────────────

/** --config-dir flag → $UXD_CONFIG_DIR → ~/.uxd. */
function resolveConfigDir(argv: string[]): string {
  const fromFlag = preScanConfigDir(argv);
  if (fromFlag) return fromFlag;
  const fromEnv = process.env.UXD_CONFIG_DIR;
  if (fromEnv && fromEnv.trim() !== "") return fromEnv;
  return defaultConfigDir();
}

/** Lightweight pre-scan for --config-dir before parse (deps need it first). */
function preScanConfigDir(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === "--") break;
    if (tok === "--config-dir") return argv[i + 1];
    if (tok.startsWith("--config-dir=")) return tok.slice("--config-dir=".length);
  }
  return undefined;
}

function wantsDebug(argv: string[]): boolean {
  if (process.env.UXD_DEBUG === "1") return true;
  const cut = argv.indexOf("--");
  const pre = cut === -1 ? argv : argv.slice(0, cut);
  return pre.includes("--verbose") || pre.includes("-v");
}

// ── ParseDeps backed by config/load ─────────────────────────────────────────

function buildDeps(configDir: string, defaults: Defaults): ParseDeps {
  const commandNames = (name: string): string[] => {
    try {
      return Object.keys(loadProject(configDir, name, defaults).commands);
    } catch {
      return [];
    }
  };
  return {
    projectExists: (name) => projectExists(configDir, name),
    knownProjects: () => listProjectNames(configDir),
    projectCommandNames: commandNames,
    projectDefaultCommand: (name) => {
      try {
        return loadProject(configDir, name, defaults).defaultCommand;
      } catch {
        return "code";
      }
    },
    resolveUrlProject: (url) => resolveUrlProject(configDir, defaults, url),
  };
}

function resolveUrlProject(
  configDir: string,
  defaults: Defaults,
  url: string,
): { project: string; ref?: RefSpec } | null {
  const parsed = parseUrlInput(url);
  if (!parsed) return null;
  for (const name of listProjectNames(configDir)) {
    let proj: ProjectConfig;
    try {
      proj = loadProject(configDir, name, defaults);
    } catch {
      continue;
    }
    const coords = normalizeRepoUrl(proj.repo);
    if (coords && coordsEqual(coords, parsed.coords)) {
      return { project: name, ref: parsed.ref };
    }
  }
  return null;
}

// ── Config-dir existence guard (§5.1) ───────────────────────────────────────

function guardConfigDir(result: ParseResult, configDir: string): void {
  if (isExemptFromConfigDir(result)) return;
  if (existsSync(configDir)) return;
  throw new UxdError("E_CONFIG", `config directory does not exist: ${configDir}`, {
    hint: "create it and add <project>.toml files, or pass --config-dir",
  });
}

function isExemptFromConfigDir(result: ParseResult): boolean {
  if (result.kind !== "top") return false;
  if (result.verb === "help" || result.verb === "version" || result.verb === "doctor") return true;
  if (result.verb === "completions") return true;
  // `config path` is exempt; `config edit/validate` are not.
  if (result.verb === "config") {
    const sub = result.args[0];
    return sub === undefined || sub === "path";
  }
  return false;
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

async function dispatch(result: ParseResult, ctx: Ctx, defaults: Defaults): Promise<number> {
  if (result.kind === "top") {
    switch (result.verb) {
      case "help":
        process.stdout.write(HELP);
        return ExitCode.SUCCESS;
      case "version":
        process.stdout.write(`uxd ${version()}\n`);
        return ExitCode.SUCCESS;
      case "projects":
        return projects({ ctx, args: result.args });
      case "doctor":
        return doctor({ ctx, args: result.args });
      case "config":
        return config({ ctx, args: result.args });
      case "completions":
        return completions({ ctx, args: result.args });
    }
  }

  if (result.kind === "project") {
    const project = loadProject(ctx.configDir, result.project, defaults);
    switch (result.verb) {
      case "list":
        // Bare `uxd <project>` on a TTY opens the interactive picker; an explicit
        // `list` verb (or non-TTY/--json) always prints the plain table (§4.3/M2).
        return result.defaulted
          ? pick({ ctx, project, args: result.args })
          : list({ ctx, project, args: result.args });
      case "clean":
        return clean({ ctx, project, args: result.args });
    }
  }

  // workspace
  const project = loadProject(ctx.configDir, result.project, defaults);
  const wi = {
    ctx,
    project,
    ref: result.ref,
    args: result.args,
    passthrough: result.passthrough,
    commandName: result.commandName,
  };
  switch (result.verb) {
    case "checkout":
      return checkout(wi);
    case "code":
      return code(wi);
    case "info":
      return info(wi);
    case "rm":
      return rm(wi);
    case "run":
      return run(wi);
    case "exec":
      return exec(wi);
    case "shell":
      return shell(wi);
    case "sync":
      return sync(wi);
    case "diff":
      return diff(wi);
    default:
      throw new UxdError("E_INTERNAL", "unhandled workspace verb");
  }
}

// ── Error formatting (§13.5) ─────────────────────────────────────────────────

function formatError(e: unknown, debug: boolean): number {
  if (isUxdError(e)) {
    process.stderr.write(`error(${e.errCode}): ${e.message}\n`);
    if (e.hint) process.stderr.write(`hint: ${e.hint}\n`);
    if (debug && e.stack) process.stderr.write(`${e.stack}\n`);
    return e.code;
  }
  const err = e as Error;
  process.stderr.write(`error(E_INTERNAL): ${err?.message ?? String(e)}\n`);
  if (debug && err?.stack) process.stderr.write(`${err.stack}\n`);
  return ExitCode.INTERNAL;
}

// Re-export for tests that want to assert the "gh disabled" path deterministically.
export { unavailableGh };
