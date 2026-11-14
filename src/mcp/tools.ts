// The tools `testlane mcp` offers (ADR-003). Each one calls its CLI verb's own
// function in-process, with `--json` and `--yes` set, and returns what the verb
// printed. No tool spawns the CLI, takes a raw argv or reaches `default_command`.
// `--yes` never approves a repo's `.testlane.toml` here (`ctx.noTrustApproval`).

import { existsSync } from "node:fs";
import { z } from "zod";
import { TestlaneError, configError, usage } from "../lib/errors.ts";
import { Logger, type LogLevel, type Sink } from "../lib/log.ts";
import { loadDefaults, loadEffectiveProject } from "../config/load.ts";
import { parseRef, refFromDisambiguator, type RefSpec } from "../core/resolve.ts";
import { RealGhClient, type GhClient } from "../git/gh.ts";
import type { Ctx, GlobalFlags } from "../config/schema.ts";
import type { WorkspaceInput } from "../commands/types.ts";
import { checkout } from "../commands/checkout.ts";
import { list, info } from "../commands/list.ts";
import { rm } from "../commands/clean.ts";
import { projects } from "../commands/projects.ts";
import { doctor } from "../commands/doctor.ts";
import { config } from "../commands/config.ts";
import { diff } from "../commands/diff.ts";
import { start, stop, logs, ps } from "../commands/lifecycle.ts";
import { BufferSink, CappedSink, TailSink } from "./sinks.ts";

/** `diff` keeps at most this much output (ADR-003). */
export const DIFF_MAX_BYTES = 1024 * 1024;
/** `checkout` and `start` stop after this many seconds unless the call says otherwise. */
export const DEFAULT_TIMEOUT_S = 600;
const MAX_TIMEOUT_S = 24 * 60 * 60;
/**
 * `start`'s own `--timeout` gets this much more than the call's, so the call's
 * deadline always fires first and answers `timedOut`, never a verb error.
 */
const START_TIMEOUT_MARGIN_S = 5;
const DEFAULT_LOG_LINES = 100;
const MAX_LOG_LINES = 1000;

// ── Arguments ───────────────────────────────────────────────────────────────

/** One argument, from which both the JSON Schema and the `zod` check are built. */
interface Param {
  type: "string" | "boolean" | "integer" | "number";
  description: string;
  required?: boolean;
  enum?: readonly string[];
  pattern?: string;
  minimum?: number;
  exclusiveMinimum?: number;
  maximum?: number;
  default?: unknown;
}

const PROJECT: Param = {
  type: "string",
  required: true,
  description: "A configured project's name, as the `projects` tool lists it.",
};
const REF: Param = {
  type: "string",
  required: true,
  description:
    "A branch name, a pull request number (`123`, `#123` or `pr/123`), a full commit SHA, an absolute path to adopt, or `-` for the last ref used.",
};
const KIND: Param = {
  type: "string",
  enum: ["pr", "branch", "path"],
  description: "Read `ref` as this kind, like the CLI's `--pr`, `--branch` and `--path`. Leave it out to let Testlane tell.",
};
const FETCH: Param = { type: "boolean", default: false, description: "Fetch the ref again first, even when its workspace exists." };
const TIMEOUT: Param = {
  type: "number",
  exclusiveMinimum: 0,
  maximum: MAX_TIMEOUT_S,
  default: DEFAULT_TIMEOUT_S,
  description:
    "Seconds the whole call may take. When they run out, Testlane stops what the call started and answers with `timedOut: true`.",
};
const DU: Param = { type: "boolean", default: false, description: "Also report each workspace's size on disk in `diskBytes`." };

const WORKSPACE = { project: PROJECT, ref: REF, kind: KIND };

function jsonSchema(params: Record<string, Param>): object {
  const properties: Record<string, object> = {};
  const required: string[] = [];
  for (const [name, p] of Object.entries(params)) {
    const { required: isRequired, ...schema } = p;
    properties[name] = schema;
    if (isRequired) required.push(name);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

function zodSchema(params: Record<string, Param>): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, p] of Object.entries(params)) {
    let s: z.ZodTypeAny;
    if (p.type === "boolean") s = z.boolean();
    else if (p.type === "string") {
      let str = z.string().min(1);
      if (p.pattern) str = str.regex(new RegExp(p.pattern), `must match ${p.pattern}`);
      s = p.enum ? z.enum(p.enum as [string, ...string[]]) : str;
    } else {
      let n = p.type === "integer" ? z.number().int() : z.number();
      if (p.minimum !== undefined) n = n.min(p.minimum);
      if (p.exclusiveMinimum !== undefined) n = n.gt(p.exclusiveMinimum);
      if (p.maximum !== undefined) n = n.max(p.maximum);
      s = n;
    }
    shape[name] = p.required ? s : s.optional();
  }
  return z.object(shape).strict();
}

// ── Results ─────────────────────────────────────────────────────────────────

export interface ToolResult {
  /** The text block's content: the verb's JSON, or an envelope from `result.ts`. */
  text: string;
  isError: boolean;
}

export interface CallOptions {
  configDir: string;
  signal: AbortSignal;
  /** Called with each step and warning line the verb logs. */
  onLine?: (level: LogLevel, message: string) => void;
  /** Where the call's log lines also go, besides its envelope. Defaults to `process.stderr`. */
  stderr?: Sink;
  gh?: () => GhClient;
}

interface CallEnv {
  ctx: Ctx;
  /** What the call logged: the envelope's `stderr`. */
  err: BufferSink;
}

const envelope = (value: object, isError: boolean): ToolResult => ({ text: JSON.stringify(value), isError });

/** A thrown error as `{error: {errCode, exitCode, message, hint}, stderr}`. */
export function errorResult(e: unknown, stderr: string): ToolResult {
  const err = e instanceof TestlaneError ? e : new TestlaneError("E_INTERNAL", (e as Error)?.message ?? String(e));
  return envelope(
    { error: { errCode: err.errCode, exitCode: err.code, message: err.message, hint: err.hint ?? null }, stderr },
    true,
  );
}

/** A `--json` verb: its JSON as it printed it, or an envelope when it printed none. */
function jsonResult(code: number, out: BufferSink, err: BufferSink): ToolResult {
  const text = out.text().trim();
  if (text === "") return envelope({ exitCode: code, stdout: "", stderr: err.text() }, code !== 0);
  return { text, isError: code !== 0 };
}

/** A verb without `--json`: `{exitCode, stdout, stderr}`. */
function textResult(code: number, stdout: string, err: BufferSink, extra: object = {}): ToolResult {
  return envelope({ exitCode: code, stdout, stderr: err.text(), ...extra }, code !== 0);
}

// ── Tools ───────────────────────────────────────────────────────────────────

export interface Tool {
  name: string;
  description: string;
  params: Record<string, Param>;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean };
  /** True for the tools that take `timeout` and send progress. */
  long: boolean;
  /** `doctor` runs without a config dir, as the CLI's does. */
  needsConfigDir: boolean;
  run(args: Record<string, unknown>, env: CallEnv): Promise<ToolResult>;
}

const READ_ONLY = { readOnlyHint: true };
const ADDITIVE = { readOnlyHint: false, destructiveHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true };

function project(env: CallEnv, args: Record<string, unknown>) {
  return loadEffectiveProject(env.ctx.configDir, args.project as string, env.ctx.defaults);
}

function refOf(args: Record<string, unknown>): RefSpec {
  const ref = args.ref as string;
  const kind = args.kind as "pr" | "branch" | "path" | undefined;
  return kind ? refFromDisambiguator(kind, ref) : parseRef(ref);
}

function workspace(env: CallEnv, args: Record<string, unknown>, verbArgs: string[]): WorkspaceInput {
  return { ctx: env.ctx, project: project(env, args), ref: refOf(args), args: verbArgs, passthrough: [] };
}

const flag = (on: unknown, name: string): string[] => (on === true ? [name] : []);

/** Run a `--json` verb into a buffer and return its JSON. */
async function viaJson(env: CallEnv, run: (ctx: Ctx) => Promise<number> | number): Promise<ToolResult> {
  const out = new BufferSink();
  env.ctx.out = out;
  const code = await run(env.ctx);
  return jsonResult(code, out, env.err);
}

export const TOOLS: Tool[] = [
  {
    name: "projects",
    description: "List the configured projects, with each one's repository and number of workspaces. Same as `testlane projects --json`.",
    params: {},
    annotations: READ_ONLY,
    long: false,
    needsConfigDir: true,
    run: (_args, env) => viaJson(env, (ctx) => projects({ ctx, args: [] })),
  },
  {
    name: "doctor",
    description:
      "Check the environment and every project config: git, gh, the config and state directories, and each project's repository. Same as `testlane doctor --json`. A failed check returns `isError: true`.",
    params: {},
    annotations: READ_ONLY,
    long: false,
    needsConfigDir: false,
    run: (_args, env) => viaJson(env, (ctx) => doctor({ ctx, args: [] })),
  },
  {
    name: "config_validate",
    description:
      "Validate every project config. Same as `testlane config validate --json`. Configs with issues return `isError: true`. The server never edits a config or records trust in one.",
    params: {},
    annotations: READ_ONLY,
    long: false,
    needsConfigDir: true,
    run: (_args, env) => viaJson(env, (ctx) => config({ ctx, args: ["validate"] })),
  },
  {
    name: "list",
    description: "List a project's workspaces. Same as `testlane <project> list --json`.",
    params: { project: PROJECT, du: DU },
    annotations: READ_ONLY,
    long: false,
    needsConfigDir: true,
    run: (args, env) =>
      viaJson(env, (ctx) => list({ ctx, project: project(env, args), args: flag(args.du, "--du") })),
  },
  {
    name: "ps",
    description:
      "List the processes that `start` left running in a project's workspaces, with each one's port, status and log file. Same as `testlane <project> ps --json`.",
    params: { project: PROJECT },
    annotations: READ_ONLY,
    long: false,
    needsConfigDir: true,
    run: (args, env) => viaJson(env, (ctx) => ps({ ctx, project: project(env, args), args: [] })),
  },
  {
    name: "info",
    description: "Show one workspace's details. Same as `testlane <project> <ref> info --json`.",
    params: { ...WORKSPACE, du: DU },
    annotations: READ_ONLY,
    long: false,
    needsConfigDir: true,
    run: (args, env) => viaJson(env, () => info(workspace(env, args, flag(args.du, "--du")))),
  },
  {
    name: "diff",
    description: `Show a workspace's changes against its base, as \`testlane <project> <ref> diff\` prints them. Returns \`{exitCode, stdout, stderr}\`, and \`truncated: true\` when the diff is over ${DIFF_MAX_BYTES / 1024 / 1024} MiB and \`stdout\` holds only its start.`,
    params: { ...WORKSPACE, stat: { type: "boolean", default: false, description: "Show only the changed files and their line counts, like `git diff --stat`." } },
    annotations: READ_ONLY,
    long: false,
    needsConfigDir: true,
    run: async (args, env) => {
      const out = new CappedSink(DIFF_MAX_BYTES);
      env.ctx.out = out;
      const code = await diff(workspace(env, args, flag(args.stat, "--stat")));
      return textResult(code, out.text(), env.err, out.truncated ? { truncated: true } : {});
    },
  },
  {
    name: "logs",
    description:
      "Read the last lines of the log of the process `start` ran in a workspace. It returns at once and never follows the log. Returns `{exitCode, stdout, stderr}`.",
    params: {
      ...WORKSPACE,
      lines: {
        type: "integer",
        minimum: 1,
        maximum: MAX_LOG_LINES,
        default: DEFAULT_LOG_LINES,
        description: "How many lines to return, counted from the end of the log.",
      },
    },
    annotations: READ_ONLY,
    long: false,
    needsConfigDir: true,
    run: async (args, env) => {
      const out = new TailSink((args.lines as number | undefined) ?? DEFAULT_LOG_LINES);
      env.ctx.out = out;
      const code = await logs(workspace(env, args, []));
      return textResult(code, out.text(), env.err);
    },
  },
  {
    name: "checkout",
    description:
      "Check out a ref into a workspace of its own, and return its path and ports. Same as `testlane <project> <ref> checkout --json`. Setup can install dependencies and take minutes, so the call sends progress and honours `timeout`.",
    params: {
      ...WORKSPACE,
      fetch: FETCH,
      setup: { type: "boolean", default: false, description: "Also run the project's setup, like `--setup`." },
      timeout: TIMEOUT,
    },
    annotations: ADDITIVE,
    long: true,
    needsConfigDir: true,
    run: (args, env) =>
      viaJson(env, () =>
        checkout(workspace(env, args, [...flag(args.fetch, "--fetch"), ...flag(args.setup, "--setup")])),
      ),
  },
  {
    name: "start",
    description:
      "Start one of the project's configured commands in a workspace, checking it out first if needed, and return once it accepts connections on its port. Returns its `url`, `pid` and `log`. Same as `testlane <project> <ref> start <command> --json`. The call sends progress and honours `timeout`.",
    params: {
      ...WORKSPACE,
      command: {
        type: "string",
        required: true,
        pattern: "^[a-z0-9][a-z0-9:_-]*$",
        description: "The name of a command in the project's `[commands]` table, like `dev`.",
      },
      fetch: FETCH,
      setup: {
        type: "boolean",
        default: true,
        description: "Run the project's setup first. It's skipped when nothing in its `cache_key` files changed.",
      },
      reseed: { type: "boolean", default: false, description: "Copy the seed files again, over the ones in the workspace." },
      timeout: TIMEOUT,
    },
    annotations: ADDITIVE,
    long: true,
    needsConfigDir: true,
    run: (args, env) => {
      const timeout = (args.timeout as number | undefined) ?? DEFAULT_TIMEOUT_S;
      const verbArgs = [
        args.command as string,
        ...flag(args.fetch, "--fetch"),
        ...(args.setup === false ? ["--no-setup"] : []),
        ...flag(args.reseed, "--reseed"),
        "--timeout",
        String(timeout + START_TIMEOUT_MARGIN_S),
      ];
      return viaJson(env, () => start(workspace(env, args, verbArgs)));
    },
  },
  {
    name: "stop",
    description:
      "Stop the process `start` left running in a workspace. Same as `testlane <project> <ref> stop`. Returns `{exitCode, stdout, stderr}`, and `stderr` says what it stopped.",
    params: WORKSPACE,
    annotations: ADDITIVE,
    long: false,
    needsConfigDir: true,
    run: async (args, env) => {
      const out = new BufferSink();
      env.ctx.out = out;
      const code = await stop(workspace(env, args, []));
      return textResult(code, out.text(), env.err);
    },
  },
  {
    name: "rm",
    description:
      "Remove a workspace: stop its process, then delete its worktree and data. Same as `testlane <project> <ref> rm --yes`. A workspace with uncommitted changes is kept, and the call returns `removed: false` with `isError: true`. Only a person can remove it then.",
    params: WORKSPACE,
    annotations: DESTRUCTIVE,
    long: false,
    needsConfigDir: true,
    run: async (args, env) => {
      const input = workspace(env, args, ["--yes"]);
      const out = new BufferSink();
      env.ctx.out = out;
      const code = await rm(input);
      const stdout = out.text();
      // `rm` prints the slug of each workspace it removed, and nothing for one it kept.
      const removed = stdout.trim() !== "";
      return envelope({ exitCode: code, stdout, stderr: env.err.text(), removed }, code !== 0 || !removed);
    },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function findTool(name: string): Tool | undefined {
  return BY_NAME.get(name);
}

/** The `tools/list` entries. */
export function toolList(): object[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: jsonSchema(t.params),
    annotations: t.annotations,
  }));
}

const FLAGS: GlobalFlags = { json: true, yes: true, quiet: false, verbose: false, dryRun: false, noColor: true };

/**
 * Run one tool call: check its arguments, build a context of its own, call the
 * verb and turn what it printed into a result. Never throws.
 */
export async function runTool(tool: Tool, rawArgs: unknown, opts: CallOptions): Promise<ToolResult> {
  const err = new BufferSink(opts.stderr ?? process.stderr);
  const parsed = zodSchema(tool.params).safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
    return errorResult(usage(`invalid arguments for '${tool.name}': ${message}`), "");
  }
  try {
    if (tool.needsConfigDir && !existsSync(opts.configDir)) {
      // The CLI's config-dir guard (§5.1), checked per call.
      throw configError(
        `config directory does not exist: ${opts.configDir}`,
        "create it and add <project>.toml files, or pass --config-dir",
      );
    }
    const log = new Logger({ quiet: false, verbose: false, color: false, sink: err, onLine: opts.onLine });
    const ctx: Ctx = {
      configDir: opts.configDir,
      defaults: loadDefaults(opts.configDir),
      flags: { ...FLAGS },
      log,
      gh: opts.gh?.() ?? new RealGhClient(),
      signal: opts.signal,
      isolated: true,
      // `yes` above answers `rm`'s question, never the trust gate's (§5.7).
      noTrustApproval: true,
    };
    return await tool.run(parsed.data, { ctx, err });
  } catch (e) {
    return errorResult(e, err.text());
  }
}
