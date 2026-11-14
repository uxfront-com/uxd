// Process execution: capture/passthrough on node:child_process (§11.1).

import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { TestlaneError, abortedError, type ErrCode } from "./errors.ts";
import type { Sink } from "./log.ts";

// Optional recorder: when set, every spawned argv is recorded before execution.
// Used by integration tests to assert which external commands ran (§17.2).
let recorder: ((argv: string[]) => void) | null = null;
export function setProcRecorder(fn: ((argv: string[]) => void) | null): void {
  recorder = fn;
}

export interface CaptureOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** When true, a non-zero exit does not throw; the result carries the code. */
  allowFailure?: boolean;
  /** errCode to attach when a non-zero exit throws (default E_EXTERNAL). */
  errCode?: ErrCode;
  /** Kill the child and reject with `abortedError()` when this fires. */
  signal?: AbortSignal;
}

export interface CaptureResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `argv` capturing stdout/stderr. Argv-based, never through a shell.
 * Non-zero exit throws TestlaneError unless `allowFailure` is set (§11.1).
 */
export async function capture(argv: string[], opts: CaptureOptions = {}): Promise<CaptureResult> {
  if (opts.signal?.aborted) throw abortedError();
  recorder?.(argv);
  return await new Promise<CaptureResult>((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env ?? (process.env as Record<string, string>),
      stdio: ["ignore", "pipe", "pipe"],
      signal: opts.signal,
    });

    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (e) => reject(opts.signal?.aborted ? abortedError() : mapSpawnError(e, argv)));
    child.on("close", (code, signal) => {
      if (opts.signal?.aborted) {
        reject(abortedError());
        return;
      }
      const exit = code ?? (signal ? 128 + signalNumber(signal) : 1);
      if (exit !== 0 && !opts.allowFailure) {
        const trimmed = stderr.trim() || stdout.trim() || `exited with code ${exit}`;
        reject(new TestlaneError(opts.errCode ?? "E_EXTERNAL", `${argv[0]}: ${trimmed}`));
        return;
      }
      resolve({ code: exit, stdout, stderr });
    });
  });
}

/**
 * `capture` with stdout kept as raw bytes, for content whose exact bytes matter
 * (a repo file's sha256, §5.7). Never throws on a non-zero exit.
 */
export async function captureBytes(
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  recorder?.(argv);
  return await new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env ?? (process.env as Record<string, string>),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (e) => reject(mapSpawnError(e, argv)));
    child.on("close", (code, signal) => {
      const exit = code ?? (signal ? 128 + signalNumber(signal) : 1);
      resolve({ code: exit, stdout: Buffer.concat(out), stderr });
    });
  });
}

export interface PassthroughOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Detach into a new session with ignored stdio (GUI editors, §10). */
  detach?: boolean;
  /**
   * Send the child's stdout to Testlane's stderr. Setup and hooks use it under
   * `--json`, so an install's output never lands in front of the JSON (§13.2).
   */
  stdoutToStderr?: boolean;
  /** Give the child a closed stdin instead of Testlane's (`testlane mcp`). */
  closeStdin?: boolean;
  /** Pipe the child's stdout into this sink. Wins over `stdoutToStderr`. */
  stdout?: Sink;
  /** Start the child as the leader of a new process group, so a stop reaches all it started. */
  ownGroup?: boolean;
  /**
   * When this fires, stop the child (its group, with `ownGroup`): SIGTERM, then
   * SIGKILL after `ABORT_GRACE_MS`. The promise settles once it has exited.
   */
  signal?: AbortSignal;
}

/** SIGTERM → SIGKILL grace for a child stopped by an abort signal (ADR-003). */
export const ABORT_GRACE_MS = 2_000;

export interface DetachOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Append stdout and stderr to this file instead of discarding them (`start`, §9.14). */
  log?: string;
}

export interface Detached {
  pid: number;
  /** Settles with the exit code (128+signal on signal death) once the child exits. */
  exited: Promise<number>;
}

/**
 * Spawn `argv` in a new session and process group (its PGID is its PID), then
 * unref it so Testlane can exit while it runs. stdio is ignored, or appended to
 * `log` when given (§10, §9.14).
 */
export async function detach(argv: string[], opts: DetachOptions = {}): Promise<Detached> {
  recorder?.(argv);
  const fd = opts.log !== undefined ? openSync(opts.log, "a") : undefined;
  try {
    return await new Promise<Detached>((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: opts.cwd,
        env: opts.env ?? (process.env as Record<string, string>),
        stdio: fd !== undefined ? ["ignore", fd, fd] : "ignore",
        detached: true,
      });
      const exited = new Promise<number>((res) => {
        child.once("exit", (code, signal) => res(signal ? 128 + signalNumber(signal) : (code ?? 0)));
      });
      child.once("error", (e) => reject(mapSpawnError(e, argv)));
      child.once("spawn", () => {
        child.unref();
        resolve({ pid: child.pid!, exited });
      });
    });
  } finally {
    // The child holds its own copy of the descriptor.
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Run `argv` with stdio inherited (or detached). Forwards SIGINT/SIGTERM to the
 * child's process group for the duration, then restores handlers (§11.1, §19.13).
 * Returns the child's exit code (128+signal on signal death).
 */
export async function passthrough(argv: string[], opts: PassthroughOptions = {}): Promise<number> {
  if (opts.detach) {
    await detach(argv, { cwd: opts.cwd, env: opts.env });
    return 0;
  }

  if (opts.signal?.aborted) throw abortedError();
  recorder?.(argv);
  return await new Promise<number>((resolve, reject) => {
    const stdin = opts.closeStdin ? "ignore" : "inherit";
    const stdout = opts.stdout ? "pipe" : opts.stdoutToStderr ? 2 : "inherit";
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env ?? (process.env as Record<string, string>),
      stdio: [stdin, stdout, "inherit"],
      detached: opts.ownGroup ?? false,
    });
    if (opts.stdout) {
      const sink = opts.stdout;
      child.stdout!.on("data", (chunk: Buffer) => sink.write(chunk));
    }

    const forward = (signal: NodeJS.Signals) => {
      try {
        child.kill(signal);
      } catch {
        // child already gone
      }
    };
    const onSigint = () => forward("SIGINT");
    const onSigterm = () => forward("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    // An abort stops the child, and the promise settles once it has exited.
    let stopping: Promise<unknown> = Promise.resolve();
    const onAbort = () => {
      const pid = child.pid;
      if (pid === undefined) return;
      stopping = opts.ownGroup ? stopGroup(pid, ABORT_GRACE_MS) : stopChild(child, ABORT_GRACE_MS);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    child.once("error", (e) => {
      cleanup();
      reject(mapSpawnError(e, argv));
    });
    // With a piped stdout, wait for the pipe to close too, so the sink has it all.
    child.once(opts.stdout ? "close" : "exit", (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      const exit = signal ? 128 + signalNumber(signal) : (code ?? 0);
      // A stopped group can outlive its leader for a moment: settle once all of it is gone.
      void stopping.then(
        () => (opts.signal?.aborted ? reject(abortedError()) : resolve(exit)),
        reject,
      );
    });
  });
}

/** SIGTERM one child, then SIGKILL it after `graceMs` if it is still there. */
async function stopChild(child: ReturnType<typeof spawn>, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
  await exited;
  clearTimeout(timer);
}

// ── Process groups (§9.15) ──────────────────────────────────────────────────

/** SIGTERM → SIGKILL grace period for `stop` (§9.15). */
export const STOP_GRACE_MS = 10_000;
const GROUP_POLL_MS = 100;

/** True while any process is left in the group `pgid`. */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return; // already gone
    if (code === "EPERM") {
      throw new TestlaneError("E_SETUP", `not permitted to signal process group ${pgid}`, {
        hint: "it belongs to another user; stop it as that user",
      });
    }
    throw e;
  }
}

/** Wait until the group is empty or `ms` passes. Returns true when it emptied. */
async function waitGroupGone(pgid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, GROUP_POLL_MS));
  }
  return true;
}

/**
 * SIGTERM the process group, wait up to `graceMs` for it to empty, then SIGKILL
 * it (§9.15). The group is the whole tree a `bash -c` started, so a dev server
 * under the shell dies with it.
 */
export async function stopGroup(pgid: number, graceMs = STOP_GRACE_MS): Promise<"terminated" | "killed"> {
  signalGroup(pgid, "SIGTERM");
  if (await waitGroupGone(pgid, graceMs)) return "terminated";
  signalGroup(pgid, "SIGKILL");
  await waitGroupGone(pgid, 2_000);
  return "killed";
}

const SIGNALS: Record<string, number> = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9, SIGQUIT: 3 };
function signalNumber(sig: string): number {
  return SIGNALS[sig] ?? 0;
}

/**
 * Map a spawn failure to a clean TestlaneError. A missing binary (ENOENT) is an
 * environment problem the user can fix, so it becomes E_SETUP with a hint
 * instead of surfacing as E_INTERNAL (§14). node:child_process reports ENOENT
 * asynchronously via the `error` event, unlike Bun's synchronous throw.
 */
function mapSpawnError(e: unknown, argv: string[]): TestlaneError {
  if ((e as NodeJS.ErrnoException).code === "ENOENT") {
    return new TestlaneError("E_SETUP", `command not found: ${argv[0]}`, {
      hint: `ensure '${argv[0]}' is installed and on your PATH`,
    });
  }
  return new TestlaneError("E_EXTERNAL", `${argv[0]}: ${(e as Error).message}`);
}
