// Process execution: capture/passthrough on Bun.spawn (§11.1).

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
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env ?? (process.env as Record<string, string>),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code !== 0 && !opts.allowFailure) {
    const trimmed = stderr.trim() || stdout.trim() || `exited with code ${code}`;
    throw new UxdError(opts.errCode ?? "E_EXTERNAL", `${argv[0]}: ${trimmed}`);
  }

  return { code, stdout, stderr };
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
    const proc = spawnOrThrow(argv, {
      cwd: opts.cwd,
      env: opts.env ?? (process.env as Record<string, string>),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    proc.unref();
    return 0;
  }

  const proc = spawnOrThrow(argv, {
    cwd: opts.cwd,
    env: opts.env ?? (process.env as Record<string, string>),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  const forward = (signal: NodeJS.Signals) => {
    try {
      proc.kill(signal);
    } catch {
      // child already gone
    }
  };
  const onSigint = () => forward("SIGINT");
  const onSigterm = () => forward("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    const code = await proc.exited;
    if (proc.signalCode) {
      return 128 + signalNumber(proc.signalCode);
    }
    return code;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

const SIGNALS: Record<string, number> = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9, SIGQUIT: 3 };
function signalNumber(sig: string): number {
  return SIGNALS[sig] ?? 0;
}

/**
 * Spawn `argv`, mapping a missing-binary ENOENT to a clean E_SETUP instead of
 * letting the raw spawn error surface as E_INTERNAL (§14). The binary being
 * absent is an environment problem the user can fix, not an internal bug.
 */
function spawnOrThrow<T extends Parameters<typeof Bun.spawn>[1]>(
  argv: string[],
  options: T,
): ReturnType<typeof Bun.spawn> {
  try {
    return Bun.spawn(argv, options);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new UxdError("E_SETUP", `command not found: ${argv[0]}`, {
        hint: `ensure '${argv[0]}' is installed and on your PATH`,
      });
    }
    throw e;
  }
}
