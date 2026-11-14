// State file (load/save, atomic) + per-project locking (§7.6, §8.2).

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { TestlaneError, abortedError, gitError } from "../lib/errors.ts";
import { stateDir } from "../lib/paths.ts";
import type { Logger } from "../lib/log.ts";

export const STATE_VERSION = 1;

export interface Workspace {
  slug: string;
  ref: string; // as originally typed
  kind: "pr" | "branch" | "commit" | "path";
  number?: number;
  branch?: string;
  path: string;
  adopted: boolean;
  ports: number[];
  createdAt: string;
  lastUsedAt: string;
  setupHash?: string;
  pr?: {
    title: string;
    author: string;
    state: string;
    url: string;
    headRefName: string;
    fetchedAt: string;
  };
}

/** The approved snapshot of a repo's `.testlane.toml` (§5.7). */
export interface RepoApproval {
  /** sha256 of the file's bytes, hex. */
  sha256: string;
  /** git blob id of the file at approval, so an unchanged tip needs no blob read. */
  blob: string;
  /** The approved file, so the config loads and diffs without git. */
  content: string;
  approvedAt: string;
}

export interface State {
  version: number;
  defaultBranch?: string;
  lastRef?: string;
  workspaces: Record<string, Workspace>;
  repoConfig?: RepoApproval;
}

function statePath(project: string): string {
  return join(stateDir(), `${project}.json`);
}

function lockPath(project: string): string {
  return join(stateDir(), `${project}.lock`);
}

function ensureStateDir(): void {
  mkdirSync(stateDir(), { recursive: true });
}

/** Load a project's state; returns an empty v1 state if the file is absent. */
export function loadState(project: string): State {
  const file = statePath(project);
  if (!existsSync(file)) {
    return { version: STATE_VERSION, workspaces: {} };
  }
  let parsed: State;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as State;
  } catch (e) {
    throw new TestlaneError("E_CONFIG", `state file ${file} is corrupt: ${(e as Error).message}`, {
      hint: "remove or repair the file",
    });
  }
  if (parsed.version !== STATE_VERSION) {
    throw new TestlaneError("E_CONFIG", `state file ${file} has unknown version ${parsed.version}`, {
      hint: `this Testlane understands version ${STATE_VERSION}; upgrade Testlane or migrate the file`,
    });
  }
  if (!parsed.workspaces) parsed.workspaces = {};
  return parsed;
}

/**
 * The approved repo-config snapshot, or undefined. Never throws: a missing,
 * corrupt or newer-version state file means "no snapshot", so commands that
 * read nothing else from state keep working on a bad file (§5.7).
 */
export function readRepoApproval(project: string): RepoApproval | undefined {
  try {
    const parsed = JSON.parse(readFileSync(statePath(project), "utf8")) as Partial<State> | null;
    if (!parsed || parsed.version !== STATE_VERSION) return undefined;
    const rc = parsed.repoConfig;
    if (!rc || typeof rc !== "object") return undefined;
    if (typeof rc.content !== "string" || typeof rc.sha256 !== "string" || typeof rc.blob !== "string") return undefined;
    return rc;
  } catch {
    return undefined;
  }
}

/** Atomically persist state (temp file + rename, §8.2, §19.9). */
export function saveState(project: string, state: State): void {
  ensureStateDir();
  const file = statePath(project);
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

// ── Locking (§7.6) ──────────────────────────────────────────────────────────

export interface Lock {
  release(): void;
}

export interface LockContents {
  pid: number;
  startedAt: string;
}

const LOCK_TIMEOUT_MS = 30_000;
const LOCK_POLL_MS = 250;

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH → dead; EPERM → alive but not ours.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Wait `ms`, or less when `signal` fires first. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Acquire an exclusive per-project lock. Steals a stale lock (dead holder) with
 * a warning; waits up to 30s on a live holder, then exits 5 (§7.6).
 */
export async function acquireLock(project: string, log: Logger, signal?: AbortSignal): Promise<Lock> {
  ensureStateDir();
  return acquireFileLock(lockPath(project), {
    label: `'${project}'`,
    timeoutMs: LOCK_TIMEOUT_MS,
    log,
    signal,
    onTimeout: (holder) =>
      gitError(
        `timed out waiting for lock on '${project}'`,
        holder ? `held by pid ${holder.pid} since ${holder.startedAt}` : undefined,
      ),
  });
}

export interface FileLockOptions {
  /** Names the lock in the stale-lock warning, e.g. `'n8n'`. */
  label: string;
  timeoutMs: number;
  log: Logger;
  /** The error thrown when a live holder outlasts `timeoutMs`. */
  onTimeout(holder: LockContents | null): TestlaneError;
  /** Stop waiting, with `abortedError()`, when this fires. */
  signal?: AbortSignal;
}

/**
 * Create `file` exclusively (`wx`) and hold it until `release()`. A lock whose
 * holder PID is dead is stolen with a warning; a live holder is waited on for
 * `timeoutMs` (§7.6). The file's directory must exist.
 */
export async function acquireFileLock(file: string, opts: FileLockOptions): Promise<Lock> {
  const deadline = Date.now() + opts.timeoutMs;

  for (;;) {
    if (opts.signal?.aborted) throw abortedError();
    try {
      const fd = openSync(file, "wx"); // O_CREAT | O_EXCL | O_WRONLY
      const contents: LockContents = { pid: process.pid, startedAt: new Date().toISOString() };
      writeSync(fd, JSON.stringify(contents));
      closeSync(fd);
      return { release: () => rmSync(file, { force: true }) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;

      const holder = readLock(file);
      if (holder && !pidAlive(holder.pid)) {
        opts.log.warn(`stealing stale lock for ${opts.label} (dead pid ${holder.pid})`);
        rmSync(file, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw opts.onTimeout(holder);
      await sleep(LOCK_POLL_MS, opts.signal);
    }
  }
}

function readLock(file: string): LockContents | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as LockContents;
  } catch {
    return null;
  }
}

export { statePath, lockPath };
