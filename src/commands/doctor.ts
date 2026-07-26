// `doctor` — diagnose the environment & configs (§9.11).

import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ExitCode } from "../lib/errors.ts";
import { stateDir } from "../lib/paths.ts";
import { checkGitVersion, fetchRefspecConfigured, hooksPathConfigured, isBareRepo, isInitialized, MIN_GIT_VERSION } from "../git/repo.ts";
import { listWorktrees } from "../git/worktree.ts";
import { listProjectNames, loadDefaults, loadProject, ConfigValidationError } from "../config/load.ts";
import { loadState } from "../core/state.ts";
import { presetBinary, isPreset } from "../core/editor.ts";
import { isWorkspaceVerb } from "../cli/verbs.ts";
import { which } from "../lib/which.ts";
import type { TopInput } from "./types.ts";

type Status = "ok" | "warn" | "fail";

interface Check {
  name: string;
  status: Status;
  detail: string;
}

function canWriteDir(dir: string): boolean {
  // Walk up to the nearest existing ancestor; a writable ancestor means we can
  // create the missing leaf. Checked via fs.accessSync W_OK below.
  let cur = dir;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
  try {
    accessSync(cur, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * PATH lookup, except a binary given as a path is checked where it points. The
 * `terminal` preset resolves to `$SHELL`, which is absolute — a PATH scan can
 * never find it and would warn on every healthy machine.
 */
function resolveBinary(bin: string): string | null {
  if (!bin.includes("/") && !bin.includes("\\")) return which(bin);
  return existsSync(bin) ? bin : null;
}

/**
 * Resolve symlinks in `dir` without requiring it to exist: realpath the nearest
 * existing ancestor and re-append the remainder. A deleted worktree still
 * normalizes to the path git would have printed for it.
 */
function canonical(dir: string): string {
  let cur = dir;
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return dir;
    tail.unshift(basename(cur));
    cur = parent;
  }
  try {
    return join(realpathSync(cur), ...tail);
  } catch {
    return dir;
  }
}

export async function doctor(input: TopInput): Promise<number> {
  const { ctx } = input;
  const checks: Check[] = [];

  // ── git version ────────────────────────────────────────────────────────────
  const git = await checkGitVersion();
  checks.push({
    name: "git version",
    status: git.ok ? "ok" : "fail",
    detail: git.ok ? `git ${git.version}` : `git ${git.version || "not found"} < ${MIN_GIT_VERSION} required`,
  });

  // ── gh present + authed ─────────────────────────────────────────────────────
  const ghOk = await ctx.gh.available();
  checks.push({
    name: "gh (github cli)",
    status: ghOk ? "ok" : "warn",
    detail: ghOk
      ? "authenticated"
      : "missing or unauthenticated — PR metadata & push-back wiring degrade gracefully",
  });

  // ── config dir exists & readable ────────────────────────────────────────────
  const cfgReadable = existsSync(ctx.configDir) && isReadable(ctx.configDir);
  checks.push({
    name: "config dir",
    status: cfgReadable ? "ok" : "fail",
    detail: cfgReadable ? ctx.configDir : `not readable: ${ctx.configDir} — create it and add <project>.toml files`,
  });

  // ── state dir writable ──────────────────────────────────────────────────────
  const sdir = stateDir();
  const stateWritable = canWriteDir(sdir);
  checks.push({
    name: "state dir",
    status: stateWritable ? "ok" : "fail",
    detail: stateWritable ? sdir : `not writable: ${sdir}`,
  });

  // ── stale lock files ────────────────────────────────────────────────────────
  const stale = staleLocks(sdir);
  if (stale.length) {
    checks.push({
      name: "locks",
      status: "warn",
      detail: `${stale.length} stale lock(s): ${stale.join(", ")} — a fresh run will steal them`,
    });
  }

  // ── per-project checks ──────────────────────────────────────────────────────
  const defaults = loadDefaults(ctx.configDir);
  for (const name of cfgReadable ? listProjectNames(ctx.configDir) : []) {
    await checkProject(ctx.configDir, name, defaults, checks);
  }

  return report(ctx.flags.json, checks);
}

async function checkProject(
  configDir: string,
  name: string,
  defaults: ReturnType<typeof loadDefaults>,
  checks: Check[],
): Promise<void> {
  let project;
  try {
    project = loadProject(configDir, name, defaults);
  } catch (e) {
    const detail = e instanceof ConfigValidationError ? e.issues.map((i) => i.message).join("; ") : String(e);
    checks.push({ name: `project ${name}: config`, status: "fail", detail });
    return;
  }
  checks.push({ name: `project ${name}: config`, status: "ok", detail: "schema-valid" });

  // repo_path parent writable / repo healthy
  if (isInitialized(project.repoPath)) {
    const bare = await isBareRepo(project.repoPath);
    checks.push({
      name: `project ${name}: repo`,
      status: bare ? "ok" : "fail",
      detail: bare ? `bare repo at ${project.repoPath}` : `not a bare repository: ${project.repoPath}`,
    });
    const refspec = await fetchRefspecConfigured(project.repoPath);
    checks.push({
      name: `project ${name}: fetch refspec`,
      status: refspec ? "ok" : "fail",
      detail: refspec
        ? "remote.origin.fetch configured"
        : `missing — run: git -C ${project.repoPath} config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'`,
    });

    // orphaned worktrees (§9.11): reconcile git's worktree list with state, both
    // directions. Git-known dirs uxd doesn't track, and tracked (non-adopted)
    // paths git no longer knows, both warrant a `clean --prune-state` nudge.
    await checkOrphans(name, project.repoPath, checks);

    // core.hooksPath / husky (§9.11, §19.4–5): relative hook paths resolve wrong
    // from worktrees. Warn, don't fix.
    const hooks = await hooksPathConfigured(project.repoPath);
    if (hooks) {
      checks.push({
        name: `project ${name}: hooks`,
        status: "warn",
        detail: `core.hooksPath=${hooks} — hooks may misbehave in worktrees (husky/relative paths)`,
      });
    }
  } else {
    const writable = canWriteDir(project.repoPath);
    checks.push({
      name: `project ${name}: repo`,
      status: writable ? "ok" : "fail",
      detail: writable ? `not yet cloned; parent writable (${project.repoPath})` : `parent not writable: ${project.repoPath}`,
    });
  }

  // editor binary resolvable (presets only; custom templates are opaque)
  if (isPreset(project.editor)) {
    const bin = presetBinary(project.editor);
    const found = bin ? resolveBinary(bin) : null;
    checks.push({
      name: `project ${name}: editor`,
      status: found ? "ok" : "warn",
      detail: found
        ? `${project.editor} (${found})`
        : `${project.editor} → '${bin}' not found; opening a workspace will fail until installed`,
    });
  }

  // configured command shadows a built-in verb
  const shadows = Object.keys(project.commands).filter((c) => isWorkspaceVerb(c));
  if (shadows.length) {
    checks.push({
      name: `project ${name}: commands`,
      status: "warn",
      detail: `command(s) shadow built-in verbs (built-in wins): ${shadows.join(", ")}`,
    });
  }

  // state file parses
  try {
    loadState(name);
  } catch (e) {
    checks.push({ name: `project ${name}: state`, status: "fail", detail: String((e as Error).message) });
  }
}

/**
 * Warn on drift between git's worktree list, the filesystem, and uxd state
 * (§9.11). The bare repo itself is excluded, and adopted (`kind: path`) entries
 * are ignored since they live outside this repo. A parse failure here is silent
 * — the state-file check in checkProject reports it separately.
 *
 * The disk check is not redundant with the git diff: git does not auto-prune, so
 * a hand-`rm -rf`'d worktree is still listed by `git worktree list` until
 * `git worktree prune` runs. Without it that drift goes unreported.
 *
 * Both sides are canonicalized before comparison because git reports resolved
 * paths; a configured `worktrees_path` crossing a symlink (`/tmp` on macOS)
 * would otherwise mismatch every entry and warn permanently.
 */
async function checkOrphans(name: string, repoPath: string, checks: Check[]): Promise<void> {
  let tracked: Set<string>;
  try {
    const st = loadState(name);
    tracked = new Set(
      Object.values(st.workspaces).filter((w) => w.kind !== "path").map((w) => canonical(w.path)),
    );
  } catch {
    return;
  }
  const repo = canonical(repoPath);
  const gitDirs = (await listWorktrees(repoPath)).map(canonical).filter((d) => d !== repo);
  const gitSet = new Set(gitDirs);
  const untracked = gitDirs.filter((d) => !tracked.has(d));
  const missing = [...tracked].filter((d) => !gitSet.has(d) || !existsSync(d));
  if (untracked.length === 0 && missing.length === 0) return;
  const bits: string[] = [];
  if (untracked.length) bits.push(`${untracked.length} git worktree(s) not in state`);
  if (missing.length) {
    bits.push(
      `${missing.length} state entr${missing.length === 1 ? "y" : "ies"} with no live worktree (deleted on disk or unknown to git)`,
    );
  }
  checks.push({
    name: `project ${name}: worktrees`,
    status: "warn",
    detail: `${bits.join("; ")} — reconcile with \`uxd ${name} clean --prune-state\``,
  });
}

function isReadable(path: string): boolean {
  try {
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
}

function staleLocks(sdir: string): string[] {
  if (!existsSync(sdir)) return [];
  const out: string[] = [];
  for (const f of readdirSync(sdir)) {
    if (!f.endsWith(".lock")) continue;
    const p = join(sdir, f);
    try {
      const { pid } = JSON.parse(readFileSync(p, "utf8")) as { pid: number };
      if (!pidAlive(pid)) out.push(f);
    } catch {
      out.push(f); // unreadable lock ⇒ stale
    }
  }
  return out;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function report(json: boolean, checks: Check[]): number {
  const failed = checks.some((c) => c.status === "fail");
  if (json) {
    process.stdout.write(JSON.stringify({ ok: !failed, checks }) + "\n");
    return failed ? ExitCode.INTERNAL : ExitCode.SUCCESS;
  }
  for (const c of checks) {
    const tag = c.status.toUpperCase().padEnd(4);
    process.stdout.write(`${tag} ${c.name}: ${c.detail}\n`);
  }
  return failed ? ExitCode.INTERNAL : ExitCode.SUCCESS;
}
