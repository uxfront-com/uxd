// Process execution: capture/passthrough on node:child_process (§11.1).

import { spawn } from "node:child_process";
import { UxdError, type ErrCode } from "./errors.ts";

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
}

export interface CaptureResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `argv` capturing stdout/stderr. Argv-based, never through a shell.
 * Non-zero exit throws UxdError unless `allowFailure` is set (§11.1).
 */
export async function capture(argv: string[], opts: CaptureOptions = {}): Promise<CaptureResult> {
  recorder?.(argv);
  return await new Promise<CaptureResult>((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env ?? (process.env as Record<string, string>),
      stdio: ["ignore", "pipe", "pipe"],
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

    child.on("error", (e) => reject(mapSpawnError(e, argv)));
    child.on("close", (code, signal) => {
      const exit = code ?? (signal ? 128 + signalNumber(signal) : 1);
      if (exit !== 0 && !opts.allowFailure) {
        const trimmed = stderr.trim() || stdout.trim() || `exited with code ${exit}`;
        reject(new UxdError(opts.errCode ?? "E_EXTERNAL", `${argv[0]}: ${trimmed}`));
        return;
      }
      resolve({ code: exit, stdout, stderr });
    });
  });
}

export interface PassthroughOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Detach into a new session with ignored stdio (GUI editors, §10). */
  detach?: boolean;
}

/**
 * Run `argv` with stdio inherited (or detached). Forwards SIGINT/SIGTERM to the
 * child's process group for the duration, then restores handlers (§11.1, §19.13).
 * Returns the child's exit code (128+signal on signal death).
 */
export async function passthrough(argv: string[], opts: PassthroughOptions = {}): Promise<number> {
  recorder?.(argv);
  if (opts.detach) {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: opts.cwd,
        env: opts.env ?? (process.env as Record<string, string>),
        stdio: "ignore",
        detached: true,
      });
      child.once("error", (e) => reject(mapSpawnError(e, argv)));
      child.once("spawn", () => {
        child.unref();
        resolve(0);
      });
    });
  }

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env ?? (process.env as Record<string, string>),
      stdio: "inherit",
    });

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

    const cleanup = () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };

    child.once("error", (e) => {
      cleanup();
      reject(mapSpawnError(e, argv));
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (signal) {
        resolve(128 + signalNumber(signal));
        return;
      }
      resolve(code ?? 0);
    });
  });
}

const SIGNALS: Record<string, number> = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9, SIGQUIT: 3 };
function signalNumber(sig: string): number {
  return SIGNALS[sig] ?? 0;
}

/**
 * Map a spawn failure to a clean UxdError. A missing binary (ENOENT) is an
 * environment problem the user can fix, so it becomes E_SETUP with a hint
 * instead of surfacing as E_INTERNAL (§14). node:child_process reports ENOENT
 * asynchronously via the `error` event, unlike Bun's synchronous throw.
 */
function mapSpawnError(e: unknown, argv: string[]): UxdError {
  if ((e as NodeJS.ErrnoException).code === "ENOENT") {
    return new UxdError("E_SETUP", `command not found: ${argv[0]}`, {
      hint: `ensure '${argv[0]}' is installed and on your PATH`,
    });
  }
  return new UxdError("E_EXTERNAL", `${argv[0]}: ${(e as Error).message}`);
}
