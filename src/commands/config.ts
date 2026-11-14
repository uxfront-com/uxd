// `config path | edit | add | validate | show | trust` (§9.12). `add <project>` is
// an alias of `edit`; `add <url>` adds a project from its repo (§5.7).

import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ExitCode, TestlaneError, configError, usage } from "../lib/errors.ts";
import { parseFlags } from "../cli/flags.ts";
import { passthrough } from "../lib/proc.ts";
import { resolvePath } from "../lib/paths.ts";
import { shellJoin } from "../lib/shell.ts";
import {
  isValidProjectName,
  loadDefaults,
  loadEffectiveProject,
  loadEffectiveProjectWithSources,
  loadProject,
  PROJECT_NAME_RULE,
  projectExists,
  projectFilePath,
  readSnapshot,
  validateAll,
} from "../config/load.ts";
import { REPO_FILE } from "../config/repo.ts";
import { stdoutOf, type Ctx, type ProjectConfig } from "../config/schema.ts";
import { defaultProjectTemplate, tomlString } from "../lib/project-template.ts";
import { resolveEditor } from "../core/editor.ts";
import { parseUrlInput } from "../core/resolve.ts";
import { acquireLock, loadState, saveState } from "../core/state.ts";
import { repoConfigBranch, trustGate, validApproval } from "../core/trust.ts";
import {
  bareCloneArgv,
  detectDefaultBranch,
  fetchBranch,
  initConfigArgvs,
  initFetchArgv,
  initPrimaryRepo,
  isInitialized,
  type GitEnv,
} from "../git/repo.ts";
import { appendDefaultsRoot, indent } from "./setup.ts";
import type { TopInput } from "./types.ts";

const SUBCOMMANDS = "expected: path | edit | add | validate | show | trust";

export async function config(input: TopInput): Promise<number> {
  const { ctx } = input;
  // `--name`/`--root` belong to `config add <url>` only; checked below.
  const flags = parseFlags(input.args, { values: ["--name", "--root"] });
  const [sub, ...rest] = flags.positionals;
  const addFlags = { name: flags.value("--name"), root: flags.value("--root") };
  const isUrlAdd = sub === "add" && rest[0] !== undefined && parseUrlInput(rest[0]) !== null;
  if (!isUrlAdd) {
    const stray = addFlags.name !== undefined ? "--name" : addFlags.root !== undefined ? "--root" : undefined;
    if (stray) throw usage(`unknown flag '${stray}'`, `${stray} applies only to \`config add <url>\``);
  }

  switch (sub) {
    case undefined:
    case "path":
      return path(ctx.configDir);
    case "edit":
      return edit(input, rest[0]);
    case "add": // `add <project>` is a discoverable alias of `edit` (§9.12).
      return isUrlAdd ? addUrl(ctx, rest[0]!, addFlags) : edit(input, rest[0]);
    case "validate":
      return validate(input, rest[0]);
    case "show":
      return show(ctx, requireProject(ctx, rest[0], "show"));
    case "trust":
      return trust(ctx, requireProject(ctx, rest[0], "trust"));
    default:
      throw usage(`unknown config subcommand '${sub}'`, SUBCOMMANDS);
  }
}

function path(configDir: string): number {
  // `config path` works even when the dir is absent (§5.1).
  process.stdout.write(`${configDir}\n`);
  return ExitCode.SUCCESS;
}

function requireProject(ctx: Ctx, project: string | undefined, sub: string): string {
  if (project === undefined) throw usage(`config ${sub} requires a project`, `testlane config ${sub} <project>`);
  if (!projectExists(ctx.configDir, project)) {
    throw usage(`unknown project '${project}'`, `no config file at ${projectFilePath(ctx.configDir, project)}`);
  }
  return project;
}

async function edit(input: TopInput, project?: string): Promise<number> {
  const { ctx } = input;
  const target = project ? projectFilePath(ctx.configDir, project) : ctx.configDir;
  const existed = project ? existsSync(target) : true;

  // Seed a starter template when the project file is absent, so the user lands
  // in a working scaffold instead of a blank buffer (§9.12). An existing file is
  // never touched — `add` stays a non-destructive alias of `edit` (AC2).
  if (project && !existed) {
    // Only names that could load as a project get seeded; a reserved or
    // malformed name would only ever produce a dead file, so refuse it (AC3).
    if (!isValidProjectName(project)) {
      throw usage(`invalid project name '${project}'`, PROJECT_NAME_RULE);
    }
    ctx.log.warn(`creating new project file: ${target}`);
    const template = defaultProjectTemplate(project);
    if (ctx.flags.dryRun) {
      // Show what would be written; --dry-run creates nothing (AC4).
      process.stdout.write(template);
    } else {
      mkdirSync(ctx.configDir, { recursive: true });
      writeFileSync(target, template, "utf8");
    }
  }

  // Prefer the project's configured editor, then $VISUAL/$EDITOR, then a preset.
  // A freshly seeded file is opened with the env editor (its config can't resolve
  // yet), so only consult a pre-existing project's `editor`.
  let editor = process.env.VISUAL || process.env.EDITOR || "";
  if (project && existed && projectExists(ctx.configDir, project)) {
    try {
      editor = loadEffectiveProject(ctx.configDir, project, loadDefaults(ctx.configDir)).editor;
    } catch {
      // fall back to env editor for a broken file so the user can fix it
    }
  }
  return openEditor(ctx, editor, target);
}

function openEditor(ctx: Ctx, editor: string, target: string): Promise<number> | number {
  const launch = resolveEditor(editor || "vi", target, { path: target });
  if (ctx.flags.dryRun) {
    process.stdout.write(`${launch.argv.join(" ")}\n`);
    return ExitCode.SUCCESS;
  }
  // Config editing is always foreground (text editors); ignore preset wait hints.
  return passthrough(launch.argv, { cwd: launch.cwd });
}

function validate(input: TopInput, project?: string): number {
  const { ctx } = input;

  if (project) {
    if (!projectExists(ctx.configDir, project)) {
      throw usage(`unknown project '${project}'`, `no config file at ${projectFilePath(ctx.configDir, project)}`);
    }
    try {
      const loaded = loadEffectiveProjectWithSources(ctx.configDir, project, loadDefaults(ctx.configDir));
      if (loaded.snapshotError) throw loaded.snapshotError;
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      return ExitCode.CONFIG;
    }
    ctx.log.step(`${project}: ok`);
    return ExitCode.SUCCESS;
  }

  const issues = validateAll(ctx.configDir, { snapshots: true });
  if (ctx.flags.json) {
    stdoutOf(ctx).write(JSON.stringify({ ok: issues.length === 0, issues }) + "\n");
    return issues.length ? ExitCode.CONFIG : ExitCode.SUCCESS;
  }
  if (issues.length === 0) {
    ctx.log.step("all project configs valid");
    return ExitCode.SUCCESS;
  }
  for (const i of issues) process.stderr.write(`${i.file}: ${i.path}: ${i.message}\n`);
  return ExitCode.CONFIG;
}

// ── config show <project> ────────────────────────────────────────────────────

/**
 * The merged config and where each key came from (§9.12). Offline: it reads the
 * user file and the approved snapshot in state, never git.
 */
function show(ctx: Ctx, name: string): number {
  const loaded = loadEffectiveProjectWithSources(ctx.configDir, name, ctx.defaults);
  const config = tomlView(loaded.project);
  const approved = loaded.approval
    ? { sha256: loaded.approval.sha256, approvedAt: loaded.approval.approvedAt }
    : null;

  if (ctx.flags.json) {
    process.stdout.write(JSON.stringify({ project: name, approved, config, sources: loaded.sources }) + "\n");
    return ExitCode.SUCCESS;
  }

  const lines: Array<[string, string, string]> = [];
  const add = (key: string, value: unknown, source: string | undefined) => {
    lines.push([key, JSON.stringify(value), source ?? "default"]);
  };
  for (const [key, value] of Object.entries(config)) {
    if (key === "setup") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) add(`setup.${k}`, v, loaded.sources[`setup.${k}`]);
    } else if (key === "env" || key === "hooks") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) add(`${key}.${k}`, v, loaded.sources[`${key}.${k}`]);
    } else if (key === "commands") {
      for (const [cname, c] of Object.entries(value as Record<string, Record<string, unknown>>)) {
        const source = loaded.sources[`commands.${cname}`];
        for (const [k, v] of Object.entries(c)) {
          if (k === "env") {
            for (const [ek, ev] of Object.entries(v as Record<string, string>)) add(`commands.${cname}.env.${ek}`, ev, source);
          } else {
            add(`commands.${cname}.${k}`, v, source);
          }
        }
      }
    } else {
      add(key, value, loaded.sources[key]);
    }
  }
  const width = Math.max(...lines.map(([k, v]) => `${k} = ${v}`.length));
  for (const [k, v, source] of lines) {
    process.stdout.write(`${`${k} = ${v}`.padEnd(width)}  # ${source}\n`);
  }
  ctx.log.step(
    approved
      ? `${name}:${REPO_FILE} trusted at ${approved.approvedAt} (sha256 ${approved.sha256.slice(0, 12)})`
      : `no trusted ${REPO_FILE} for ${name}`,
  );
  return ExitCode.SUCCESS;
}

/** The resolved config under its TOML key names; unset optional keys are left out. */
function tomlView(p: ProjectConfig): Record<string, unknown> {
  const setup: Record<string, unknown> = { cache_key: p.setup.cacheKey, seed_files: p.setup.seedFiles };
  if (p.setup.run !== undefined) setup.run = p.setup.run;
  if (p.setup.seedFrom !== undefined) setup.seed_from = p.setup.seedFrom;
  const commands: Record<string, Record<string, unknown>> = {};
  for (const [cname, c] of Object.entries(p.commands)) {
    commands[cname] = { run: c.run, ...(c.cwd !== undefined ? { cwd: c.cwd } : {}), env: c.env };
  }
  return {
    repo: p.repo,
    repo_path: p.repoPath,
    worktrees_path: p.worktreesPath,
    ...(p.defaultBranch !== undefined ? { default_branch: p.defaultBranch } : {}),
    editor: p.editor,
    default_command: p.defaultCommand,
    ports: p.ports,
    base_port: p.basePort,
    setup,
    env: p.env,
    commands,
    hooks: p.hooks,
  };
}

// ── config trust <project> ───────────────────────────────────────────────────

/**
 * Fetch the default branch, show the repo file (or the diff from the approved
 * one), ask, and record the approval (§5.7, §9.12).
 */
async function trust(ctx: Ctx, name: string): Promise<number> {
  // The user file alone: the snapshot is what this command replaces, so a stale
  // or broken one must not stop it. Its `default_command` may name a command
  // from the file this approves, so the check waits for that file (§5.7).
  const project = loadProject(ctx.configDir, name, ctx.defaults, undefined, { deferDefaultCommand: true });
  if (ctx.flags.dryRun) {
    throw usage("config trust does not support --dry-run", `inspect the file with \`git show origin/<branch>:${REPO_FILE}\``);
  }
  const lock = await acquireLock(name, ctx.log);
  try {
    const g: GitEnv = { repoPath: project.repoPath, dryRun: false, log: ctx.log };
    if (!isInitialized(project.repoPath)) await initPrimaryRepo(g, project.repo);
    const branch = await repoConfigBranch(project, () => detectDefaultBranch(g));
    if (!branch) {
      throw configError(`cannot tell the default branch of ${name}`, `set default_branch in ${name}.toml`);
    }
    await fetchBranch(g, branch);
    const state = loadState(name);
    const result = await trustGate(ctx, project, state, { explicit: true });
    if (result.stateChanged) saveState(name, state);
    // The deferred check. The gate checked a file it approves before recording
    // it; with nothing new approved, the user file must load with what is.
    if (result.outcome !== "approved" && result.outcome !== "declined") {
      loadProject(ctx.configDir, name, ctx.defaults, readSnapshot(name, validApproval(state.repoConfig)).layer);
    }
    return ExitCode.SUCCESS;
  } finally {
    lock.release();
  }
}

// ── config add <url> ─────────────────────────────────────────────────────────

/** The clone URL `config add` writes: ssh verbatim; https as `https://<host>/<owner>/<repo>.git`. */
export function cloneUrlFor(input: string): string | null {
  if (/[\s\u0000-\u001f\u007f]/.test(input)) return null;
  if (/^git@[^:]+:.+$/.test(input)) return input;
  const m = input.match(/^(https?):\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/);
  if (!m) return null;
  return `${m[1]}://${m[2]}/${m[3]}/${m[4]}.git`;
}

/** The repo's name in a clone URL, lower-cased: `git@host:org/My_App.git/` → `my_app`. */
export function repoNameOf(cloneUrl: string): string {
  const path = cloneUrl.replace(/\/+$/, "").replace(/\.git$/, "");
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf(":")) + 1).toLowerCase();
}

/**
 * `config add <url>`: write a minimal `<name>.toml`, clone the primary repo,
 * then trust its `.testlane.toml` — or, without one, seed today's template and
 * open the editor (§9.12). Every check runs before anything is written.
 */
async function addUrl(ctx: Ctx, url: string, flags: { name?: string; root?: string }): Promise<number> {
  const repo = cloneUrlFor(url);
  if (!repo) throw usage(`cannot derive a clone URL from '${url}'`, "pass an ssh or https repository URL");
  const name = flags.name ?? repoNameOf(repo);
  if (!isValidProjectName(name)) {
    throw usage(`invalid project name '${name}'`, `${PROJECT_NAME_RULE}; pass --name <name>`);
  }

  const configDir = ctx.configDir;
  const dirExisted = existsSync(configDir);
  const projectFile = projectFilePath(configDir, name);
  if (existsSync(projectFile)) {
    throw configError(
      `project '${name}' already exists`,
      `edit it with \`testlane config edit ${name}\`, or choose another name with --name`,
    );
  }

  const defaults = dirExisted ? loadDefaults(configDir) : {};
  const flagRoot = flags.root?.trim();
  if (flags.root !== undefined && !flagRoot) throw usage("--root requires a directory");
  if (defaults.root !== undefined && flagRoot !== undefined && resolvePath(flagRoot) !== resolvePath(defaults.root)) {
    throw usage(
      `--root ${flagRoot} conflicts with defaults.root = ${defaults.root}`,
      "drop --root, or change root in defaults.toml",
    );
  }
  const root = defaults.root ?? flagRoot;
  if (root === undefined) {
    throw configError("defaults.root is not set", "pass --root <dir>, for example --root ~/dev/testlane");
  }
  const writeRoot = defaults.root === undefined;

  const defaultsFile = join(configDir, "defaults.toml");
  const projectToml = `repo = ${tomlString(repo)}\n`;
  // The paths this project will resolve to, from the defaults it will have.
  const repoPath = resolvePath(join(root, name, "repo"));
  if (existsSync(repoPath)) {
    throw configError(`${repoPath} already exists`, "remove it, or choose another name with --name");
  }

  if (ctx.flags.dryRun) {
    if (!dirExisted) process.stdout.write(`mkdir -p ${configDir}\n`);
    if (writeRoot) process.stdout.write(`write ${defaultsFile}\n  root = ${tomlString(root)}\n`);
    process.stdout.write(`write ${projectFile}\n${indent(projectToml)}`);
    process.stdout.write(`${shellJoin(bareCloneArgv(repo, repoPath))}\n`);
    for (const argv of initConfigArgvs(repoPath)) process.stdout.write(`${shellJoin(argv)}\n`);
    process.stdout.write(`${shellJoin(initFetchArgv(repoPath))}\n`);
    return ExitCode.SUCCESS;
  }

  // ── Apply. ────────────────────────────────────────────────────────────────
  // What a failed clone puts back, so a retry starts from where this run did.
  const defaultsBefore = existsSync(defaultsFile) ? readFileSync(defaultsFile, "utf8") : undefined;
  const rootDir = resolvePath(root);
  const rootExisted = existsSync(rootDir);
  const rollback = (): void => {
    rmSync(projectFile, { force: true });
    if (writeRoot) {
      if (defaultsBefore === undefined) rmSync(defaultsFile, { force: true });
      else writeFileSync(defaultsFile, defaultsBefore);
    }
    // Innermost first; each only if this run created it and it's empty.
    const created = [dirname(repoPath), ...(rootExisted ? [] : [rootDir]), ...(dirExisted ? [] : [configDir])];
    for (const dir of created) {
      try {
        rmdirSync(dir); // only when empty
      } catch {
        // not empty, or already gone
      }
    }
  };
  if (!dirExisted) {
    mkdirSync(configDir, { recursive: true });
    ctx.log.step(`created config dir ${configDir}`);
  }
  if (writeRoot) {
    appendDefaultsRoot(defaultsFile, root);
    ctx.log.step(`set defaults.root = ${root}`);
  }
  try {
    // `wx`: a concurrent `config add` of the same name loses here, not silently.
    writeFileSync(projectFile, projectToml, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw configError(`project '${name}' already exists`);
    throw e;
  }
  ctx.log.step(`wrote ${projectFile}`);

  const fresh = { ...ctx, defaults: loadDefaults(configDir) };
  const project = loadProject(configDir, name, fresh.defaults);
  const lock = await acquireLock(name, ctx.log);
  try {
    const g: GitEnv = { repoPath: project.repoPath, dryRun: false, log: ctx.log };
    try {
      await initPrimaryRepo(g, repo);
    } catch (e) {
      // repo_path didn't exist before this run (checked above).
      rmSync(project.repoPath, { recursive: true, force: true });
      rollback();
      if (e instanceof TestlaneError && e.errCode === "E_GIT") throw e;
      throw new TestlaneError("E_GIT", `cloning ${repo} failed: ${(e as Error).message}`);
    }

    const state = loadState(name);
    // A state file left by an earlier project of this name must not lend its
    // approval to this repo.
    // Saved before the gate, which throws off a terminal without --yes.
    if (state.repoConfig !== undefined) {
      delete state.repoConfig;
      saveState(name, state);
    }
    const result = await trustGate(fresh, project, state, {
      explicit: true,
      untrustedHint: `testlane config trust ${name}`,
    });
    if (result.stateChanged) saveState(name, state);
    if (result.outcome !== "no-file" && result.outcome !== "no-ref") {
      ctx.log.step(`next: testlane ${name} ${result.branch ?? "<branch|pr|path>"}`);
      return ExitCode.SUCCESS;
    }
  } finally {
    lock.release();
  }

  // No repo file: today's template, with the real repo line, opened for editing.
  writeFileSync(projectFile, defaultProjectTemplate(name, repo), "utf8");
  return openEditor(ctx, process.env.VISUAL || process.env.EDITOR || "", projectFile);
}
