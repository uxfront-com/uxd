// Logger: stderr steps, levels, color gating (§13).

import pc from "picocolors";

export interface LoggerOptions {
  quiet: boolean;
  verbose: boolean;
  color: boolean;
}

export class Logger {
  private readonly quiet: boolean;
  private readonly verbose_: boolean;
  private readonly color: boolean;

  constructor(opts: LoggerOptions) {
    this.quiet = opts.quiet;
    this.verbose_ = opts.verbose;
    this.color = opts.color;
  }

  private dim(s: string): string {
    return this.color ? pc.dim(s) : s;
  }

  /** One `→`-prefixed step line on stderr. Silenced by --quiet. */
  step(message: string): void {
    if (this.quiet) return;
    process.stderr.write(`${this.dim("→")} ${message}\n`);
  }

  /** Verbose-only detail (e.g. external command + timing). */
  debug(message: string): void {
    if (!this.verbose_) return;
    process.stderr.write(`${this.dim("·")} ${message}\n`);
  }

  /** Warnings always print, even under --quiet. */
  warn(message: string): void {
    const label = this.color ? pc.yellow("warning") : "warning";
    process.stderr.write(`${label}: ${message}\n`);
  }

  get isVerbose(): boolean {
    return this.verbose_;
  }

  get isQuiet(): boolean {
    return this.quiet;
  }
}

/**
 * Decide whether ANSI color is allowed: honors --no-color, NO_COLOR env,
 * and a non-TTY stderr (§13.3).
 */
export function colorEnabled(noColorFlag: boolean): boolean {
  if (noColorFlag) return false;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  return Boolean(process.stderr.isTTY);
}
