// Setup pipeline (§8.4): seed files → cache-key hash → cached install → pre_run.

import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { configError, setupError } from "../lib/errors.ts";
import { expandTilde } from "../lib/paths.ts";
import { passthrough } from "../lib/proc.ts";
import { shellJoin } from "../lib/shell.ts";
import { interpolate } from "../lib/template.ts";
import { composeEnv, templateVars, type WorkspaceContext } from "./env.ts";
import { runHook } from "./hooks.ts";
import type { Ctx, ProjectConfig } from "../config/schema.ts";
import type { Workspace } from "./state.ts";

export interface SetupOptions {
  /** Overwrite existing seed targets before copying. */
  reseed: boolean;
  /** Run the `pre_run` hook after install (run/exec/shell callers only). */
  preRun: boolean;
}

/**
 * Seed + (cached) install + optional pre_run hook. Mutates `ws.setupHash` when a
 * fresh install succeeds; the caller persists state afterward. Throws E_SETUP on
 * install or hook failure, leaving the old hash so the next attempt retries.
 */
export async function runSetup(
  ctx: Ctx,
  project: ProjectConfig,
  ws: Workspace,
  wc: WorkspaceContext,
  opts: SetupOptions,
): Promise<void> {
  seed(ctx, project, ws.path, opts.reseed);

  if (project.setup.run) {
    const hash = await computeSetupHash(ws.path, project.setup.cacheKey);
    if (hash !== ws.setupHash) {
      await install(ctx, project, ws, wc);
      ws.setupHash = hash;
    } else {
      ctx.log.step("setup up to date (cache hit)");
    }
  }

  if (opts.preRun) {
    await runHook(ctx, project, wc, "pre_run", true);
  }
}

// ── Seeding (§8.4.1) ────────────────────────────────────────────────────────

function seed(ctx: Ctx, project: ProjectConfig, worktree: string, reseed: boolean): void {
  const seedFiles = project.setup.seedFiles;
  if (seedFiles.length === 0) return;

  const configBase = join(ctx.configDir, "seeds", project.name);
  const fromBase = project.setup.seedFrom ? expandTilde(project.setup.seedFrom) : undefined;

  for (const rel of seedFiles) {
    assertSafeRelative(rel);
    const target = join(worktree, rel);

    if (reseed && existsSync(target)) rmSync(target, { force: true });
    if (existsSync(target)) continue; // never overwrite

    const source = [join(configBase, rel), fromBase ? join(fromBase, rel) : undefined]
      .filter((s): s is string => s !== undefined)
      .find((s) => existsSync(s));

    if (!source) {
      ctx.log.warn(`no seed source for '${rel}' (looked in seeds/${project.name}${fromBase ? " and seed_from" : ""})`);
      continue;
    }

    if (ctx.flags.dryRun) {
      process.stdout.write(`cp ${shellJoin([source, target])}\n`);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    ctx.log.step(`seeded ${rel}`);
  }
}

/** A seed path must be relative and free of `..` segments (§5.4, §8.4). */
function assertSafeRelative(rel: string): void {
  if (isAbsolute(rel) || rel.split(/[/\\]/).some((seg) => seg === "..")) {
    throw configError(`unsafe seed_files entry '${rel}'`, "must be a relative path with no '..' segments");
  }
}

// ── Cache-key hashing (§8.4.2) ──────────────────────────────────────────────

/**
 * sha256 over the sorted `cache_key` glob matches, hashing each relative path and
 * its bytes. Anything under `node_modules/` or `.git/` is excluded. An empty glob
 * set yields a stable hash so a `setup.run` with no cache_key installs exactly once.
 */
export async function computeSetupHash(worktree: string, globs: string[]): Promise<string> {
  const matched = new Set<string>();
  for (const pattern of globs) {
    const glob = new Bun.Glob(pattern);
    for await (const rel of glob.scan({ cwd: worktree, dot: true, onlyFiles: true })) {
      const segments = rel.split("/");
      if (segments.includes("node_modules") || segments.includes(".git")) continue;
      matched.add(rel);
    }
  }

  const hash = createHash("sha256");
  for (const rel of [...matched].sort()) {
    const bytes = await Bun.file(join(worktree, rel)).arrayBuffer();
    hash.update(rel);
    hash.update("\0");
    hash.update(Buffer.from(bytes));
    hash.update("\0");
  }
  return hash.digest("hex");
}

// ── Install (§8.4.3) ────────────────────────────────────────────────────────

async function install(ctx: Ctx, project: ProjectConfig, ws: Workspace, wc: WorkspaceContext): Promise<void> {
  const script = interpolate(project.setup.run!, templateVars(wc), "setup.run");
  const env = composeEnv(wc, project);

  if (ctx.flags.dryRun) {
    process.stdout.write(`${shellJoin(["bash", "-c", script])}\n`);
    return;
  }

  ctx.log.step("running setup");
  const code = await passthrough(["bash", "-c", script], { cwd: ws.path, env });
  if (code !== 0) throw setupError(`setup command failed (exit ${code})`);
}
