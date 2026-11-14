// start / stop / logs / ps — one detached process per workspace (§9.14–9.17).

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { ExitCode, abortedError, gitError, setupError, usage } from "../lib/errors.ts";
import { parseFlags } from "../cli/flags.ts";
import { ABORT_GRACE_MS, detach } from "../lib/proc.ts";
import type { Sink } from "../lib/log.ts";
import { pad } from "../lib/table.ts";
import { shellJoin } from "../lib/shell.ts";
import { composeEnv } from "../core/env.ts";
import { slug as slugFor } from "../core/resolve.ts";
import { acquireFileLock, loadState } from "../core/state.ts";
import { dataDirFor, ensureWorkspace, resolveLast } from "../core/workspace.ts";
import {
  STOP_GRACE_MS,
  isLive,
  logFile,
  portAccepts,
  readEntry,
  removeEntry,
  startLockFile,
  startTime,
  stopGroup,
  stopRecorded,
  tailLines,
  waitForPort,
  writeEntry,
  type ProcessEntry,
} from "../core/supervise.ts";
import { buildCommand, commandName, parseEnvFlags, printDryRun } from "./process.ts";
import { stdoutOf, type Ctx, type ProjectConfig } from "../config/schema.ts";
import type { ProjectInput, WorkspaceInput } from "./types.ts";

/** Default readiness wait for `start`, in seconds (§9.14). */
const DEFAULT_TIMEOUT_S = 300;
const LOG_TAIL_LINES = 20;

// ── start <name> ─────────────────────────────────────────────────────────────

export async function start(input: WorkspaceInput): Promise<number> {
  const { ctx, project } = input;
  const flags = parseFlags(input.args, {
    bools: ["--no-setup", "--reseed", "--fetch"],
    values: ["--timeout", "--port"],
    multi: ["--env"],
  });
  if (flags.value("--port") !== undefined) {
    throw usage(
      "start does not take --port",
      "the process always serves the workspace's own {port}, so hooks and `ps` see the same one",
    );
  }
  const name = commandName(project, flags.positionals[0], "start");
  const timeoutMs = parseTimeout(flags.value("--timeout"));
  const flagEnv = parseEnvFlags(flags.list("--env"));
  const ensureOpts = {
    setup: !flags.bool("--no-setup"),
    fetch: flags.bool("--fetch"),
    reseed: flags.bool("--reseed"),
    preRun: true,
  };

  const spec = resolveLast(project, input.ref);

  if (ctx.flags.dryRun) {
    const { ws, dataDir } = await ensureWorkspace(ctx, project, spec, ensureOpts);
    const cmd = buildCommand(project, ws, dataDir, name, input.passthrough, flagEnv);
    printDryRun(cmd.wc, project, cmd.extra, cmd.argv);
    return ExitCode.SUCCESS;
  }

  const slug = slugFor(spec);
  const dataDir = dataDirFor(project, slug);
  const freshDataDir = !existsSync(dataDir);
  mkdirSync(dataDir, { recursive: true });

  // Concurrent starts of one workspace queue here, each for its own --timeout,
  // without holding the project lock through the readiness wait.
  const lock = await acquireFileLock(startLockFile(dataDir), {
    label: `start of ${project.name}/${slug}`,
    timeoutMs,
    log: ctx.log,
    signal: ctx.signal,
    onTimeout: (holder) =>
      gitError(
        `timed out waiting for another start of ${project.name}/${slug}`,
        holder ? `held by pid ${holder.pid} since ${holder.startedAt}` : undefined,
      ),
  });
  let discard = false;
  try {
    const current = readEntry(dataDir);
    if (current && (await isLive(current))) {
      if (current.command !== name) {
        throw usage(
          `'${current.command}' is already running in ${project.name}/${slug} (pid ${current.pid})`,
          `stop it first: testlane ${project.name} ${refFor(project, slug)} stop`,
        );
      }
      ctx.log.step(`${name} already running (pid ${current.pid})`);
      printStarted(ctx, project, slug, current, true);
      return ExitCode.SUCCESS;
    }
    // A dead or reused PID: the entry is stale.
    if (current) removeEntry(dataDir, current.pid);

    const { ws } = await ensureWorkspace(ctx, project, spec, ensureOpts);
    // The trust gate may have approved a repo file that drops this command.
    commandName(project, name, "start");
    const cmd = buildCommand(project, ws, dataDir, name, input.passthrough, flagEnv);
    const port = ws.ports[0]!;

    if (await portAccepts(port)) {
      throw setupError(
        `port ${port} already accepts connections, so Testlane can't tell when '${name}' is ready`,
        `free 127.0.0.1:${port} (\`lsof -nP -iTCP:${port} -sTCP:LISTEN\` shows the holder), then start again`,
      );
    }

    const log = logFile(dataDir);
    const child = await detach(cmd.argv, {
      cwd: cmd.cwd,
      env: composeEnv(cmd.wc, project, cmd.extra),
      log,
    });
    let exited = false;
    void child.exited.then(() => {
      exited = true;
    });

    const entry: ProcessEntry = {
      pid: child.pid,
      lstart: (await startTime(child.pid)) ?? "",
      command: name,
      port,
      log,
      startedAt: new Date().toISOString(),
    };
    // Recorded before the wait, so an interrupted start can still be stopped.
    writeEntry(dataDir, entry);
    ctx.log.step(`started ${name} (pid ${child.pid}), waiting for 127.0.0.1:${port}`);

    const outcome = await waitForPort(port, Date.now() + timeoutMs, () => exited, ctx.signal);
    if (outcome === "ready" && entry.lstart !== "") {
      printStarted(ctx, project, slug, entry, false);
      return ExitCode.SUCCESS;
    }

    // Not ready: leave no process and no live entry behind. A stopped call
    // (`testlane mcp`) waits only the short grace, so it can answer in time.
    await stopGroup(child.pid, outcome === "aborted" ? ABORT_GRACE_MS : STOP_GRACE_MS);
    removeEntry(dataDir, child.pid);
    if (outcome === "aborted") throw abortedError();
    if (outcome === "exited") {
      writeTail(ctx, log);
      throw setupError(`'${name}' exited before 127.0.0.1:${port} accepted connections`, `full log: ${log}`);
    }
    if (outcome === "timeout") {
      throw setupError(
        `'${name}' did not accept connections on 127.0.0.1:${port} within ${timeoutMs / 1000}s`,
        `bind the server to 127.0.0.1:{port} (TESTLANE_PORT=${port}), or raise --timeout; log: ${log}`,
      );
    }
    throw setupError(`could not read the start time of pid ${child.pid} with ps`, "check that `ps` is on your PATH");
  } catch (e) {
    // A start that never materialized the workspace (an unknown branch, say)
    // leaves no data dir behind for a workspace that doesn't exist.
    discard = freshDataDir && !loadState(project.name).workspaces[slug];
    throw e;
  } finally {
    lock.release();
    if (discard) {
      try {
        // Not recursive: a start that took the lock meanwhile keeps its dir.
        rmdirSync(dataDir);
      } catch {
        // not empty, or already gone
      }
    }
  }
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_S * 1000;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n) || n <= 0) {
    throw usage(`--timeout expects a number of seconds above 0, got '${raw}'`);
  }
  return n * 1000;
}

function printStarted(ctx: Ctx, project: ProjectConfig, slug: string, e: ProcessEntry, reused: boolean): void {
  const url = `http://127.0.0.1:${e.port}`;
  if (ctx.flags.json) {
    const out = {
      project: project.name,
      slug,
      command: e.command,
      pid: e.pid,
      port: e.port,
      url,
      log: e.log,
      startedAt: e.startedAt,
      reused,
    };
    stdoutOf(ctx).write(JSON.stringify(out) + "\n");
    return;
  }
  ctx.log.step(`${e.command} ready on ${url} (pid ${e.pid}, log ${e.log})`);
  stdoutOf(ctx).write(`${url}\n`);
}

function writeTail(ctx: Ctx, log: string): void {
  const lines = tailLines(log, LOG_TAIL_LINES);
  if (lines.length === 0) return;
  ctx.log.write(`last ${lines.length} log line(s):\n`);
  for (const line of lines) ctx.log.write(`  ${line}\n`);
}

/** The ref to type for a slug's workspace: as originally typed, else the slug. */
function refFor(project: ProjectConfig, slug: string): string {
  const ref = loadState(project.name).workspaces[slug]?.ref ?? slug;
  return shellJoin([ref]);
}

// ── stop ─────────────────────────────────────────────────────────────────────

export async function stop(input: WorkspaceInput): Promise<number> {
  const { ctx, project } = input;
  parseFlags(input.args, {});
  const slug = slugFor(resolveLast(project, input.ref));
  const dataDir = dataDirFor(project, slug);

  if (ctx.flags.dryRun) {
    const entry = readEntry(dataDir);
    if (entry && (await isLive(entry))) {
      stdoutOf(ctx).write(`kill -TERM -- -${entry.pid}\n`);
      stdoutOf(ctx).write(`rm ${join(dataDir, "process.json")}\n`);
    }
    return ExitCode.SUCCESS;
  }

  const outcome = await stopRecorded(dataDir);
  if (outcome.kind === "none") {
    ctx.log.step(`not running: ${project.name}/${slug}`);
  } else if (outcome.kind === "exited") {
    ctx.log.step(`not running: ${outcome.entry.command} (pid ${outcome.entry.pid}) had already exited`);
  } else {
    const how = outcome.how === "killed" ? "killed after the grace period" : "stopped";
    ctx.log.step(`${outcome.entry.command} ${how} (pid ${outcome.entry.pid})`);
  }
  return ExitCode.SUCCESS;
}

// ── logs [-f] ────────────────────────────────────────────────────────────────

export async function logs(input: WorkspaceInput): Promise<number> {
  const { ctx, project } = input;
  const out = stdoutOf(ctx);
  const flags = parseFlags(input.args, { bools: ["-f", "--follow"] });
  const slug = slugFor(resolveLast(project, input.ref));
  const file = logFile(dataDirFor(project, slug));
  if (!existsSync(file)) {
    throw usage(`no log for ${project.name}/${slug}`, `start a command first: testlane ${project.name} <ref> start <name>`);
  }

  let offset = await copyFrom(file, 0, out);
  if (!(flags.bool("-f") || flags.bool("--follow"))) return ExitCode.SUCCESS;

  // Follow until interrupted, like `tail -f`. A truncated file is read again from the top.
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    while (!interrupted) {
      await new Promise((r) => setTimeout(r, 200));
      if (!existsSync(file)) continue;
      offset = await copyFrom(file, offset, out);
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  return ExitCode.SUCCESS;
}

/** Copy `file` from `offset` to `out` in chunks. Returns the new offset. */
async function copyFrom(file: string, offset: number, out: Sink): Promise<number> {
  const fd = openSync(file, "r");
  try {
    let pos = fstatSync(fd).size < offset ? 0 : offset;
    const buf = Buffer.alloc(64 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n === 0) return pos;
      pos += n;
      if (!out.write(Buffer.from(buf.subarray(0, n)))) {
        await new Promise<void>((r) => out.once("drain", () => r()));
      }
    }
  } finally {
    closeSync(fd);
  }
}

// ── ps ───────────────────────────────────────────────────────────────────────

interface PsRow {
  slug: string;
  command: string;
  pid: number;
  port: number;
  status: "running" | "exited";
  startedAt: string;
  log: string;
}

export async function ps(input: ProjectInput): Promise<number> {
  const { ctx, project } = input;
  parseFlags(input.args, {});

  // Every workspace in state, plus any data dir left without a state entry.
  const slugs = new Set(Object.keys(loadState(project.name).workspaces));
  const dataRoot = join(project.worktreesPath, ".data");
  if (existsSync(dataRoot)) {
    for (const d of readdirSync(dataRoot, { withFileTypes: true })) if (d.isDirectory()) slugs.add(d.name);
  }

  const rows: PsRow[] = [];
  for (const slug of [...slugs].sort()) {
    const e = readEntry(dataDirFor(project, slug));
    if (!e) continue;
    rows.push({
      slug,
      command: e.command,
      pid: e.pid,
      port: e.port,
      status: (await isLive(e)) ? "running" : "exited",
      startedAt: e.startedAt,
      log: e.log,
    });
  }

  if (ctx.flags.json) {
    stdoutOf(ctx).write(JSON.stringify(rows) + "\n");
    return ExitCode.SUCCESS;
  }
  if (rows.length === 0) {
    ctx.log.step(`no processes for '${project.name}'`);
    return ExitCode.SUCCESS;
  }
  const header = ["SLUG", "COMMAND", "PID", "PORT", "STATUS", "STARTED", "LOG"];
  const body = rows.map((r) => [r.slug, r.command, String(r.pid), String(r.port), r.status, r.startedAt, r.log]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  for (const row of [header, ...body]) {
    stdoutOf(ctx).write(row.map((c, i) => pad(c, widths[i]!)).join("  ").trimEnd() + "\n");
  }
  return ExitCode.SUCCESS;
}
