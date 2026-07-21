// Exit codes and the single error type main.ts formats (§14).

export const ExitCode = {
  SUCCESS: 0,
  INTERNAL: 1,
  USAGE: 2,
  CONFIG: 3,
  RESOLVE: 4,
  GIT: 5,
  SETUP: 6,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export type ErrCode =
  | "E_INTERNAL"
  | "E_USAGE"
  | "E_CONFIG"
  | "E_RESOLVE"
  | "E_GIT"
  | "E_SETUP"
  | "E_EXTERNAL";

const CODE_FOR: Record<ErrCode, ExitCode> = {
  E_INTERNAL: ExitCode.INTERNAL,
  E_USAGE: ExitCode.USAGE,
  E_CONFIG: ExitCode.CONFIG,
  E_RESOLVE: ExitCode.RESOLVE,
  E_GIT: ExitCode.GIT,
  E_SETUP: ExitCode.SETUP,
  // E_EXTERNAL is a git/gh plumbing failure; surfaces as E_GIT to the user.
  E_EXTERNAL: ExitCode.GIT,
};

export class UxdError extends Error {
  readonly code: ExitCode;
  readonly errCode: ErrCode;
  readonly hint?: string;

  constructor(errCode: ErrCode, message: string, opts?: { hint?: string; code?: ExitCode }) {
    super(message);
    this.name = "UxdError";
    this.errCode = errCode;
    this.code = opts?.code ?? CODE_FOR[errCode];
    this.hint = opts?.hint;
  }
}

export function isUxdError(e: unknown): e is UxdError {
  return e instanceof UxdError;
}

// Convenience constructors keep call sites terse.
export const usage = (message: string, hint?: string) => new UxdError("E_USAGE", message, { hint });
export const configError = (message: string, hint?: string) => new UxdError("E_CONFIG", message, { hint });
export const resolveError = (message: string, hint?: string) => new UxdError("E_RESOLVE", message, { hint });
export const gitError = (message: string, hint?: string) => new UxdError("E_GIT", message, { hint });
export const setupError = (message: string, hint?: string) => new UxdError("E_SETUP", message, { hint });
