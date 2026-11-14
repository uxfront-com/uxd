// run / exec / shell — materialize + setup, then execute in the worktree (§9.3–9.5).

import { isAbsolute, join } from "node:path";
import { ExitCode, usage } from "../lib/errors.ts";
import { parseFlags } from "../cli/flags.ts";
import { passthrough } from "../lib/proc.ts";
import { shellJoin, shellQuote } from "../lib/shell.ts";
import { interpolate } from "../lib/template.ts";
import { ensureWorkspace } from "../core/workspace.ts";
import { composeEnv, exportedEnv, templateVars, wsContext, type WorkspaceContext } from "../core/env.ts";
import type { ProjectConfig } from "../config/schema.ts";
import type { Workspace } from "../core/state.ts";
import type { WorkspaceInput } from "./types.ts";

// ── run <name> ───────────────────────────────────────────────────────────────

export async function run(input: WorkspaceInput): Promise<number> {
  const { ctx, project, ref } = input;
  const flags = parseFlags(input.args, {
    bools: ["--no-setup", "--reseed", "--fetch"],
    values: ["--port"],
    multi: ["--env"],
  });

  const name = commandName(project, flags.positionals[0], "run");
  const flagEnv = parseEnvFlags(flags.list("--env"));

  const { ws, dataDir } = await ensureWorkspace(ctx, project, ref, {
    setup: !flags.bool("--no-setup"),
    fetch: flags.bool("--fetch"),
    reseed: flags.bool("--reseed"),
    preRun: true,
  });
  // The trust gate may have approved a repo file that drops this command.
  commandName(project, name, "run");

  const cmd = buildCommand(project, ws, dataDir, name, input.passthrough, flagEnv, flags.value("--port"));

  if (ctx.flags.dryRun) {
    printDryRun(cmd.wc, project, cmd.extra, cmd.argv);
    return ExitCode.SUCCESS;
  }
  return passthrough(cmd.argv, { cwd: cmd.cwd, env: composeEnv(cmd.wc, project, cmd.extra) });
}

/** The configured command `name`, or a usage error listing the configured ones. */
export function commandName(project: ProjectConfig, name: string | undefined, verb: string): string {
  if (name === undefined) {
    throw usage(`${verb} requires a command name`, commandHint(project));
  }
  if (!project.commands[name]) {
    throw usage(`unknown command '${name}'`, commandHint(project));
  }
  return name;
}

export interface BuiltCommand {
  wc: WorkspaceContext;
  argv: string[];
  cwd: string;
  extra: { commandEnv?: Record<string, string>; flagEnv: Record<string, string> };
}

/**
 * Template `commands.<name>` for a workspace, the way `run` executes it (§9.3):
 * `bash -c '<run> "$@"' testlane <extra…>` in the command's cwd. `start` builds its
 * command here too, so the two never drift apart.
 */
export function buildCommand(
  project: ProjectConfig,
  ws: Workspace,
  dataDir: string,
  name: string,
  passthroughArgs: string[],
  flagEnv: Record<string, string>,
  portFlag?: string,
): BuiltCommand {
  const command = project.commands[name]!;
  const wc = wsContextWithPort(project, ws, dataDir, portFlag);
  const vars = templateVars(wc);
  const runStr = interpolate(command.run, vars, `commands.${name}.run`);
  const cwd = commandCwd(ws, command.cwd, vars, name);
  // Passthrough args are appended shell-safely: bash -c '<run> "$@"' testlane <extra…>.
  const argv = ["bash", "-c", `${runStr} "$@"`, "testlane", ...passthroughArgs];
  return { wc, argv, cwd, extra: { commandEnv: command.env, flagEnv } };
}

// ── exec -- <argv...> ────────────────────────────────────────────────────────

export async function exec(input: WorkspaceInput): Promise<number> {
  const { ctx, project, ref } = input;
  const flags = parseFlags(input.args, { bools: ["--no-setup", "--reseed", "--fetch"] });

  if (input.passthrough.length === 0) {
    throw usage("exec requires a command after '--'", "e.g. `testlane <project> <ref> exec -- npm test`");
  }

  const { ws, dataDir } = await ensureWorkspace(ctx, project, ref, {
    setup: !flags.bool("--no-setup"),
    fetch: flags.bool("--fetch"),
    reseed: flags.bool("--reseed"),
    preRun: true,
  });

  const wc = wsContext(project, ws, dataDir);
  const argv = input.passthrough;

  if (ctx.flags.dryRun) {
    printDryRun(wc, project, {}, argv);
    return ExitCode.SUCCESS;
  }
  // Spawned directly — no shell (§9.4).
  return passthrough(argv, { cwd: ws.path, env: composeEnv(wc, project) });
}

// ── shell ────────────────────────────────────────────────────────────────────

export async function shell(input: WorkspaceInput): Promise<number> {
  const { ctx, project, ref } = input;
  const flags = parseFlags(input.args, { bools: ["--no-setup", "--reseed", "--fetch"] });

  const { ws, dataDir } = await ensureWorkspace(ctx, project, ref, {
    setup: !flags.bool("--no-setup"),
    fetch: flags.bool("--fetch"),
    reseed: flags.bool("--reseed"),
    preRun: true,
  });

  const wc = wsContext(project, ws, dataDir);
  const shellBin = process.env.SHELL || "bash";

  if (ctx.flags.dryRun) {
    printDryRun(wc, project, {}, [shellBin]);
    return ExitCode.SUCCESS;
  }

  const port = ws.ports[0] !== undefined ? String(ws.ports[0]) : "-";
  process.stderr.write(`testlane: ${project.name}/${ws.slug} — port ${port} — ${ws.path}\n`);
  return passthrough([shellBin], { cwd: ws.path, env: composeEnv(wc, project) });
}

// ── helpers ──────────────────────────────────────────────────────────────────

function commandHint(project: ProjectConfig): string {
  const names = Object.keys(project.commands);
  return `configured commands: ${names.join(", ") || "(none)"}`;
}

/**
 * A `--port` override replaces the block's first port for this invocation only —
 * env and templates see it, but state is left unchanged (§9.3).
 */
function wsContextWithPort(
  project: ProjectConfig,
  ws: Workspace,
  dataDir: string,
  portFlag: string | undefined,
): WorkspaceContext {
  const override = parsePort(portFlag);
  if (override === undefined) return wsContext(project, ws, dataDir);
  return wsContext(project, { ...ws, ports: [override, ...ws.ports.slice(1)] }, dataDir);
}

function commandCwd(ws: Workspace, cwd: string | undefined, vars: Record<string, string>, name: string): string {
  if (!cwd) return ws.path;
  const resolved = interpolate(cwd, vars, `commands.${name}.cwd`);
  return isAbsolute(resolved) ? resolved : join(ws.path, resolved);
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw usage(`--port expects a port number (1–65535), got '${value}'`);
  }
  return n;
}

export function parseEnvFlags(items: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of items) {
    const eq = item.indexOf("=");
    if (eq <= 0) throw usage(`--env expects K=V, got '${item}'`);
    out[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return out;
}

/**
 * `--dry-run`: print env layers 2–5 as `export` lines, then the shell-quoted
 * command (§11.2, §13.4). No spawn, no lock.
 */
export function printDryRun(
  wc: WorkspaceContext,
  project: ProjectConfig,
  extra: { commandEnv?: Record<string, string>; flagEnv?: Record<string, string> },
  argv: string[],
): void {
  const vars = templateVars(wc);
  const layered: Record<string, string> = { ...exportedEnv(wc) };
  for (const [k, v] of Object.entries(project.env)) layered[k] = interpolate(v, vars, `env.${k}`);
  if (extra.commandEnv) {
    for (const [k, v] of Object.entries(extra.commandEnv)) layered[k] = interpolate(v, vars, `command.env.${k}`);
  }
  if (extra.flagEnv) Object.assign(layered, extra.flagEnv);

  for (const [k, v] of Object.entries(layered)) {
    process.stdout.write(`export ${k}=${shellQuote(v)}\n`);
  }
  process.stdout.write(`${shellJoin(argv)}\n`);
}
