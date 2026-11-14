// The trust gate for a repo's `.testlane.toml` (§5.7, §8.1). The file is read
// only from `refs/remotes/origin/<default>` in the primary repo, never from a
// worktree or the ref being materialized, and its commands run only after the
// user approves that exact content. The gate can only move the approved
// snapshot forward (approve) or drop it (file removed upstream).

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configError } from "../lib/errors.ts";
import { sha256Hex } from "../lib/hash.ts";
import { capture } from "../lib/proc.ts";
import { promptLine } from "../lib/prompt.ts";
import { printableBlock, printableLine } from "../lib/printable.ts";
import { loadProject, readSnapshot } from "../config/load.ts";
import { parseRepoConfig, REPO_FILE, repoLabel } from "../config/repo.ts";
import type { Ctx, ProjectConfig, RawRepo } from "../config/schema.ts";
import { detectDefaultBranch, isInitialized, readBlob, symbolicHead, treeEntry, type GitEnv } from "../git/repo.ts";
import type { RepoApproval, State } from "./state.ts";

/** Terminal access, injectable so tests can drive the TTY branch. */
export interface TrustIO {
  isTTY(): boolean;
  /** Ask one question; the answer line, or null on EOF. */
  prompt(message: string): string | null;
  /** Human output (stderr, §13.1). */
  write(text: string): void;
}

export const processIO: TrustIO = {
  isTTY: () => Boolean(process.stdin.isTTY),
  // On stderr, so `cd "$(testlane app main checkout)"` still shows the question.
  prompt: (message) => promptLine(message, process.stderr),
  write: (text) => {
    process.stderr.write(text);
  },
};

export interface TrustGateOptions {
  /**
   * `config trust` and `config add`: always show the file or the diff, and
   * report the outcome. A run shows them only when it is about to approve or ask.
   */
  explicit?: boolean;
  /** Hint for the non-TTY "not trusted" error. Default: `testlane config trust <project>`. */
  untrustedHint?: string;
  io?: TrustIO;
}

export type TrustOutcome =
  /** origin/<default> isn't in the local repo: nothing to compare, nothing changes. */
  | "no-ref"
  | "no-file"
  /** The file is gone upstream; the stored approval was dropped. */
  | "removed"
  /** The tip is the approved content. */
  | "trusted"
  | "approved"
  | "declined";

export interface TrustResult {
  outcome: TrustOutcome;
  /** The default branch the file was read from, when one resolved. */
  branch?: string;
  /** True when `state.repoConfig` changed, so the caller must save state. */
  stateChanged: boolean;
}

/** The approval, if `state.repoConfig` is well-formed; a hand-mangled one counts as none. */
export function validApproval(rc: unknown): RepoApproval | undefined {
  if (!rc || typeof rc !== "object") return undefined;
  const r = rc as Record<string, unknown>;
  if (typeof r.sha256 !== "string" || typeof r.blob !== "string" || typeof r.content !== "string") return undefined;
  return rc as RepoApproval;
}

/**
 * The stored approval, if it can still be used. One that no longer matches its
 * sha256 or no longer validates counts as none, with a warning, so the gate
 * shows the file and asks again as on first use, and `config trust` repairs it.
 */
function usableApproval(ctx: Ctx, name: string, state: State): RepoApproval | undefined {
  const snap = readSnapshot(name, validApproval(state.repoConfig));
  if (snap.error) {
    const why = snap.error.issues.map((i) => i.message).join("; ");
    ctx.log.warn(`the stored approval of ${repoLabel(name)} is unusable (${why}); asking again`);
    return undefined;
  }
  return snap.approval;
}

/**
 * The branch whose tip holds the repo file: the user's `default_branch`, else
 * the bare clone's HEAD (origin's default at clone time), else `detect` — the
 * network lookup, `git ls-remote --symref origin HEAD`, when the caller allows it.
 */
export async function repoConfigBranch(
  project: ProjectConfig,
  detect?: () => Promise<string | undefined>,
): Promise<string | undefined> {
  if (project.defaultBranch) return project.defaultBranch;
  const head = await symbolicHead(project.repoPath);
  if (head) return head;
  return detect ? await detect() : undefined;
}

export type RepoTip =
  | { kind: "no-ref" }
  | { kind: "no-file" }
  | { kind: "file"; blob: string };

/**
 * Locate `.testlane.toml` at `refs/remotes/origin/<branch>`. Never
 * `refs/heads/*`: a bare clone's local branches are frozen at clone time.
 * Reads tree objects only, so it needs no network.
 */
export async function readRepoTip(repoPath: string, branch: string, project: string): Promise<RepoTip> {
  const ref = `refs/remotes/origin/${branch}`;
  let entry;
  try {
    entry = await treeEntry(repoPath, ref, REPO_FILE);
  } catch {
    return { kind: "no-ref" };
  }
  if (!entry) return { kind: "no-file" };
  if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
    throw configError(`${repoLabel(project)} on origin/${branch} is not a regular file`, "commit it as a plain file");
  }
  return { kind: "file", blob: entry.id };
}

/**
 * Run the gate against the `state` the caller holds, under the project lock.
 * Writes an approval into `state.repoConfig` (or drops it); the caller saves.
 * Throws E_CONFIG when the tip doesn't validate (§5.7), or when it needs an
 * answer and can't ask: stdin is not a TTY and `--yes` is not set, or the
 * context is one where nobody can approve (`ctx.noTrustApproval`, `testlane mcp`).
 */
export async function trustGate(
  ctx: Ctx,
  project: ProjectConfig,
  state: State,
  opts: TrustGateOptions = {},
): Promise<TrustResult> {
  const io = opts.io ?? processIO;
  const name = project.name;
  const label = repoLabel(name);
  const g: GitEnv = { repoPath: project.repoPath, dryRun: false, log: ctx.log };

  const branch = await repoConfigBranch(project, () => detectDefaultBranch(g));
  if (!branch) return { outcome: "no-ref", stateChanged: false };
  const tip = await readRepoTip(project.repoPath, branch, name);
  const approval = usableApproval(ctx, name, state);

  if (tip.kind === "no-ref") return { outcome: "no-ref", branch, stateChanged: false };

  if (tip.kind === "no-file") {
    if (state.repoConfig === undefined) {
      if (opts.explicit) ctx.log.step(`no ${REPO_FILE} on origin/${branch}`);
      return { outcome: "no-file", branch, stateChanged: false };
    }
    delete state.repoConfig;
    ctx.log.step(`${label} is gone from origin/${branch}; dropped its approval`);
    return { outcome: "removed", branch, stateChanged: true };
  }

  if (approval && approval.blob === tip.blob) {
    if (opts.explicit) ctx.log.step(`${label} is already trusted (sha256 ${approval.sha256.slice(0, 12)})`);
    return { outcome: "trusted", branch, stateChanged: false };
  }

  // The tip differs from the approval: read, validate (§5.7 A4) and ask.
  const bytes = await readBlob(project.repoPath, tip.blob, `${label} on origin/${branch}`);
  const content = bytes.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(bytes)) {
    throw configError(`${label} on origin/${branch} is not valid UTF-8`);
  }
  const layer = parseRepoConfig(name, content);
  // The merged config must load too, before anyone is asked to approve it.
  loadProject(ctx.configDir, name, ctx.defaults, layer);
  const sha256 = sha256Hex(bytes);

  const first = approval === undefined;
  // Under `testlane mcp` no call can approve: not `--yes`, and not a terminal,
  // since stdin there carries the protocol, not a person's answer.
  const approvable = !ctx.noTrustApproval;
  const yesFlag = approvable && ctx.flags.yes;
  const canAsk = approvable && io.isTTY();
  if (!yesFlag && !canAsk) {
    if (opts.explicit) await show(io, label, branch, approval, content, layer);
    throw configError(
      first ? `${label} is not trusted` : `${label} changed since you trusted it`,
      opts.untrustedHint ?? (opts.explicit ? "re-run on a terminal, or pass --yes" : `testlane config trust ${name}`),
    );
  }

  await show(io, label, branch, approval, content, layer);

  let yes = yesFlag;
  if (!yes) {
    const answer = io.prompt(`Trust ${label}? [y/N]`);
    yes = answer !== null && /^y(es)?$/i.test(answer.trim());
  }
  if (!yes) {
    ctx.log.step(first ? `not trusted; using ${name}.toml on its own` : `not trusted; keeping the version you trusted before`);
    return { outcome: "declined", branch, stateChanged: false };
  }

  state.repoConfig = { sha256, blob: tip.blob, content, approvedAt: new Date().toISOString() };
  ctx.log.step(`trusted ${label} (sha256 ${sha256.slice(0, 12)})`);
  return { outcome: "approved", branch, stateChanged: true };
}

/**
 * Re-merge `project` in place from the user file and the snapshot in the held
 * `state`, so every hook, setup and command after the gate uses the config the
 * gate settled. A default branch detected at clone time is kept.
 */
export function settleProject(ctx: Ctx, project: ProjectConfig, state: State): void {
  const { layer } = readSnapshot(project.name, validApproval(state.repoConfig));
  const fresh = loadProject(ctx.configDir, project.name, ctx.defaults, layer);
  if (!fresh.defaultBranch && project.defaultBranch) fresh.defaultBranch = project.defaultBranch;
  Object.assign(project, fresh);
}

/**
 * The gate as `ensureWorkspace` runs it (§8.1): skipped when the primary repo
 * isn't initialized (an adopted path), then the project is re-settled.
 */
export async function runTrustGate(ctx: Ctx, project: ProjectConfig, state: State, io?: TrustIO): Promise<TrustResult> {
  if (!isInitialized(project.repoPath)) return { outcome: "no-ref", stateChanged: false };
  const result = await trustGate(ctx, project, state, { io });
  settleProject(ctx, project, state);
  return result;
}

// ── What the user is shown ──────────────────────────────────────────────────

export { printableBlock, printableLine } from "../lib/printable.ts";

async function show(
  io: TrustIO,
  label: string,
  branch: string,
  approval: RepoApproval | undefined,
  content: string,
  layer: RawRepo,
): Promise<void> {
  if (approval) {
    io.write(`${label} on origin/${branch} changed since you trusted it:\n`);
    io.write(printableBlock(await unifiedDiff(approval.content, content, `origin/${branch}`)));
    return;
  }
  io.write(summary(label, branch, layer));
  io.write(`--- ${label} (origin/${branch}) ---\n`);
  const shown = printableBlock(content);
  io.write(shown.endsWith("\n") || shown === "" ? shown : `${shown}\n`);
  io.write(`---\n`);
}

/** What a first-use file would run: setup, each command (with its cwd), each hook. */
export function summary(label: string, branch: string, layer: RawRepo): string {
  const rows: Array<[string, string]> = [];
  const line = printableLine;
  if (layer.setup?.run !== undefined) rows.push(["setup.run", line(layer.setup.run)]);
  for (const [cname, c] of Object.entries(layer.commands ?? {})) {
    const run = line(c.run);
    rows.push([`commands.${cname}.run`, c.cwd !== undefined ? `${run}   (cwd: ${line(c.cwd)})` : run]);
  }
  for (const [hook, run] of Object.entries(layer.hooks ?? {})) {
    if (run !== undefined) rows.push([`hooks.${hook}`, line(run)]);
  }
  if (rows.length === 0) return `${label} on origin/${branch} defines no commands, hooks or setup.\n`;
  const width = Math.max(...rows.map(([k]) => k.length));
  const lines = rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`);
  return `${label} on origin/${branch} would run:\n${lines.join("\n")}\n`;
}

/** A unified diff from the approved content to the tip, made by git (no new dependency). */
export async function unifiedDiff(before: string, after: string, afterName: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "testlane-trust-"));
  try {
    const a = join("trusted", REPO_FILE);
    const b = join(afterName, REPO_FILE);
    mkdirSync(join(dir, "trusted"), { recursive: true });
    mkdirSync(join(dir, afterName), { recursive: true });
    writeFileSync(join(dir, a), before);
    writeFileSync(join(dir, b), after);
    const res = await capture(
      ["git", "diff", "--no-index", "--no-color", "--no-ext-diff", "--no-prefix", "--", a, b],
      { cwd: dir, allowFailure: true },
    );
    // Exit 1 means "the files differ"; anything else is git failing.
    if (res.code > 1) throw configError(`cannot diff ${REPO_FILE}: ${res.stderr.trim()}`);
    return res.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
