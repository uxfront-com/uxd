// Config discovery, TOML parse, defaults merge, aggregate error reporting (§5).

import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { isAbsolute, join, relative, sep } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { TestlaneError } from "../lib/errors.ts";
import { resolvePath } from "../lib/paths.ts";
import { printableLine } from "../lib/printable.ts";
import { fnv1a32 } from "../lib/hash.ts";
import {
  RawDefaultsSchema,
  RawProjectSchema,
  type Defaults,
  type ProjectConfig,
  type RawRepo,
} from "./schema.ts";
import { DEFAULT_COMMAND_VERBS } from "../cli/verbs.ts";
import { mergeRaw, parseRepoConfig, repoLabel, type KeySource } from "./repo.ts";
import { readRepoApproval, type RepoApproval } from "../core/state.ts";
import { sha256Hex } from "../lib/hash.ts";

const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const RESERVED_NAMES = new Set(["defaults", "seeds"]);

export interface ConfigIssue {
  file: string;
  path: string;
  message: string;
}

export class ConfigValidationError extends TestlaneError {
  readonly issues: ConfigIssue[];
  constructor(issues: ConfigIssue[], opts: { hint?: string } = {}) {
    const body = issues.map((i) => `${i.file}: ${i.path}: ${i.message}`).join("\n");
    super("E_CONFIG", body, { hint: opts.hint });
    this.issues = issues;
    this.name = "ConfigValidationError";
  }
}

function zodIssues(file: string, err: z.ZodError): ConfigIssue[] {
  return err.issues.map((issue) => ({
    file,
    path: issue.path.length ? issue.path.join(".") : "(root)",
    message: issue.message,
  }));
}

// ── Discovery ───────────────────────────────────────────────────────────────

/** List project names (config files without `.toml`, excluding reserved). */
export function listProjectNames(configDir: string): string[] {
  if (!existsSync(configDir)) return [];
  return readdirSync(configDir)
    .filter((f) => f.endsWith(".toml"))
    .map((f) => f.slice(0, -".toml".length))
    .filter((name) => !RESERVED_NAMES.has(name) && PROJECT_NAME_RE.test(name))
    .sort();
}

export function projectFilePath(configDir: string, name: string): string {
  return join(configDir, `${name}.toml`);
}

/** Human-readable form of the project-name rule, for usage errors (§5.1). */
export const PROJECT_NAME_RULE = "must match ^[a-z0-9][a-z0-9._-]*$ and cannot be 'defaults' or 'seeds'";

/** True if `name` is a legal, non-reserved project name (§5.1). */
export function isValidProjectName(name: string): boolean {
  return PROJECT_NAME_RE.test(name) && !RESERVED_NAMES.has(name);
}

export function projectExists(configDir: string, name: string): boolean {
  if (!isValidProjectName(name)) return false;
  return existsSync(projectFilePath(configDir, name));
}

// ── defaults.toml ─────────────────────────────────────────────────────────

export function loadDefaults(configDir: string): Defaults {
  const file = join(configDir, "defaults.toml");
  if (!existsSync(file)) return {};
  const issues: ConfigIssue[] = [];
  const raw = parseTomlFile(file, "defaults.toml", issues);
  if (issues.length) throw new ConfigValidationError(issues);
  const parsed = RawDefaultsSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigValidationError(zodIssues("defaults.toml", parsed.error));
  return {
    root: parsed.data.root,
    editor: parsed.data.editor,
    defaultCommand: parsed.data.default_command,
  };
}

function parseTomlFile(file: string, label: string, issues: ConfigIssue[]): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    issues.push({ file: label, path: "(root)", message: `cannot read file: ${(e as Error).message}` });
    return {};
  }
  try {
    return parseToml(text);
  } catch (e) {
    issues.push({ file: label, path: "(root)", message: `TOML parse error: ${(e as Error).message}` });
    return {};
  }
}

// ── Project resolution ──────────────────────────────────────────────────────

/** Derived base port: 3000 + (fnv1a32(project) % 40) * 100 (§5.4). */
export function deriveBasePort(project: string): number {
  return 3000 + (fnv1a32(project) % 40) * 100;
}

/**
 * Load & fully resolve one project config. Aggregates all schema/semantic
 * errors for the file into a single ConfigValidationError (exit 3, §5.4).
 * `repo` is an already-validated `.testlane.toml` layer, merged under the
 * user file (§5.7); without it the user file is loaded on its own.
 */
export interface LoadOptions {
  /**
   * Leave `default_command` unchecked. Only `config trust` uses it: the command
   * it names may come from the repo file being approved, and the gate checks
   * the user file merged with that file before it records anything (§5.7).
   */
  deferDefaultCommand?: boolean;
}

export function loadProject(
  configDir: string,
  name: string,
  defaults: Defaults,
  repo?: RawRepo,
  opts: LoadOptions = {},
): ProjectConfig {
  return loadProjectWithSources(configDir, name, defaults, repo, opts).project;
}

export interface LoadedProject {
  project: ProjectConfig;
  /** Dotted key → where its value came from: the user file, the repo file, or a default (§5.7). */
  sources: Record<string, KeySource>;
}

/** `loadProject`, plus where each effective key came from (`config show`, §9.12). */
export function loadProjectWithSources(
  configDir: string,
  name: string,
  defaults: Defaults,
  repo?: RawRepo,
  opts: LoadOptions = {},
): LoadedProject {
  const label = `${name}.toml`;
  const file = projectFilePath(configDir, name);

  if (!PROJECT_NAME_RE.test(name)) {
    throw new ConfigValidationError([
      { file: label, path: "(name)", message: `invalid project name; must match ${PROJECT_NAME_RE}` },
    ]);
  }
  if (!existsSync(file)) {
    throw new TestlaneError("E_CONFIG", `unknown project '${name}'`, {
      hint: `no config file at ${file}`,
    });
  }

  const issues: ConfigIssue[] = [];
  const raw = parseTomlFile(file, label, issues);
  if (issues.length) throw new ConfigValidationError(issues);

  const parsed = RawProjectSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigValidationError(zodIssues(label, parsed.error));
  }
  const merged = mergeRaw(parsed.data, repo);
  const p = merged.raw;
  // A semantic issue names the file its key came from (§5.7).
  const fileOf = (key: string): string => (merged.sources[key] === "repo" ? repoLabel(name) : label);

  // ── Derive paths (§5.4). ──────────────────────────────────────────────────
  const root = p.repo_path && p.worktrees_path ? undefined : defaults.root;
  if (!p.repo_path && !root) {
    issues.push({ file: label, path: "repo_path", message: "required when defaults.root is unset" });
  }
  if (!p.worktrees_path && !root) {
    issues.push({ file: label, path: "worktrees_path", message: "required when defaults.root is unset" });
  }

  const repoPath = p.repo_path
    ? resolvePath(p.repo_path)
    : root
      ? resolvePath(join(root, name, "repo"))
      : "";
  const worktreesPath = p.worktrees_path
    ? resolvePath(p.worktrees_path)
    : root
      ? resolvePath(join(root, name, "trees"))
      : "";

  if (repoPath && worktreesPath && isInside(worktreesPath, repoPath)) {
    issues.push({ file: label, path: "worktrees_path", message: "must not be inside repo_path" });
  }

  // ── setup validation (§5.4). ──────────────────────────────────────────────
  const seedFiles = p.setup?.seed_files ?? [];
  seedFiles.forEach((rel, i) => {
    if (isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
      issues.push({
        file: fileOf("setup.seed_files"),
        path: `setup.seed_files.${i}`,
        message: printableLine(`must be a relative path with no '..' segments (got '${rel}')`),
      });
    }
  });

  // ── default_command validation (§5.4). ────────────────────────────────────
  const commandNames = Object.keys(p.commands ?? {});
  const defaultCommand = p.default_command ?? defaults.defaultCommand ?? "code";
  const validTargets = new Set<string>([...DEFAULT_COMMAND_VERBS, ...commandNames]);
  if (!opts.deferDefaultCommand && !validTargets.has(defaultCommand)) {
    issues.push({
      file: fileOf("default_command"),
      path: "default_command",
      message: printableLine(`unknown command '${defaultCommand}'; expected a verb or one of [${commandNames.join(", ")}]`),
    });
  }

  if (issues.length) throw new ConfigValidationError(issues);

  const commands: ProjectConfig["commands"] = {};
  for (const [cname, c] of Object.entries(p.commands ?? {})) {
    commands[cname] = { run: c.run, cwd: c.cwd, env: c.env ?? {} };
  }

  // Every effective key either file leaves unset comes from a default.
  const sources: Record<string, KeySource> = { ...merged.sources };
  for (const key of ["repo_path", "worktrees_path", "editor", "default_command", "ports", "base_port", "setup.cache_key", "setup.seed_files"]) {
    sources[key] ??= "default";
  }

  const project: ProjectConfig = {
    name,
    repo: p.repo,
    repoPath,
    worktreesPath,
    defaultBranch: p.default_branch,
    editor: p.editor ?? defaults.editor ?? "code",
    defaultCommand,
    ports: p.ports ?? 1,
    basePort: p.base_port ?? deriveBasePort(name),
    setup: {
      run: p.setup?.run,
      cacheKey: p.setup?.cache_key ?? [],
      seedFiles,
      seedFrom: p.setup?.seed_from ? resolvePath(p.setup.seed_from) : undefined,
    },
    env: p.env ?? {},
    commands,
    hooks: p.hooks ?? {},
  };
  return { project, sources };
}

/**
 * Validate an approved snapshot (§5.7). Throws a ConfigValidationError
 * labelled `<project>:.testlane.toml` when it no longer validates or no longer
 * matches the hash it was approved under.
 */
export function snapshotLayer(name: string, approval: RepoApproval): RawRepo {
  if (sha256Hex(Buffer.from(approval.content, "utf8")) !== approval.sha256) {
    throw new ConfigValidationError([
      {
        file: repoLabel(name),
        path: "(root)",
        message: "the approved snapshot does not match its sha256",
      },
    ]);
  }
  return parseRepoConfig(name, approval.content);
}

export interface SnapshotRead {
  approval?: RepoApproval;
  /** The validated layer, when the approval is usable. */
  layer?: RawRepo;
  /** Why a stored approval is unusable: a hash mismatch or a schema error. */
  error?: ConfigValidationError;
}

/**
 * Validate a stored approval without throwing. A broken one has `error` set
 * and no `layer`: everything treats it as no approval, and `config trust`
 * asks again as on first use (§5.7).
 */
export function readSnapshot(name: string, approval: RepoApproval | undefined): SnapshotRead {
  if (!approval) return {};
  try {
    return { approval, layer: snapshotLayer(name, approval) };
  } catch (e) {
    if (e instanceof ConfigValidationError) return { approval, error: e };
    throw e;
  }
}

/**
 * The config a run uses: the user file plus the last approved snapshot of the
 * repo's `.testlane.toml` from project state (§5.7). Never throws on state: a
 * missing, corrupt or newer-version state file, or a snapshot that no longer
 * validates, means "no snapshot". `config validate` and `doctor` report the
 * last case through `snapshotError`.
 */
export function loadEffectiveProject(configDir: string, name: string, defaults: Defaults): ProjectConfig {
  return loadEffectiveProjectWithSources(configDir, name, defaults).project;
}

export function loadEffectiveProjectWithSources(
  configDir: string,
  name: string,
  defaults: Defaults,
): LoadedProject & { approval?: RepoApproval; snapshotError?: ConfigValidationError } {
  // An invalid name never reaches the state dir; loadProject reports it.
  const snap = readSnapshot(name, PROJECT_NAME_RE.test(name) ? readRepoApproval(name) : undefined);
  let loaded: LoadedProject;
  try {
    loaded = loadProjectWithSources(configDir, name, defaults, snap.layer);
  } catch (e) {
    // With no approved repo file, a user `default_command` may name one of its
    // commands that isn't approved yet (§5.7): point at the way to approve it.
    const label = `${name}.toml`;
    if (
      !snap.layer &&
      e instanceof ConfigValidationError &&
      !e.hint &&
      e.issues.some((i) => i.file === label && i.path === "default_command")
    ) {
      throw new ConfigValidationError(e.issues, { hint: `testlane config trust ${name}` });
    }
    throw e;
  }
  return {
    ...loaded,
    approval: snap.layer ? snap.approval : undefined,
    snapshotError: snap.error,
  };
}

export interface ValidateOptions {
  /** Also validate each project's approved repo-config snapshot from state (§5.7). */
  snapshots?: boolean;
}

/** Validate every project (and defaults) for `config validate`; returns all issues. */
export function validateAll(configDir: string, opts: ValidateOptions = {}): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  let defaults: Defaults = {};
  try {
    defaults = loadDefaults(configDir);
  } catch (e) {
    if (e instanceof ConfigValidationError) issues.push(...e.issues);
    else throw e;
  }
  for (const name of listProjectNames(configDir)) {
    try {
      if (opts.snapshots) {
        const loaded = loadEffectiveProjectWithSources(configDir, name, defaults);
        if (loaded.snapshotError) issues.push(...loaded.snapshotError.issues);
      } else {
        loadProject(configDir, name, defaults);
      }
    } catch (e) {
      if (e instanceof ConfigValidationError) issues.push(...e.issues);
      else if (e instanceof TestlaneError) issues.push({ file: `${name}.toml`, path: "(root)", message: e.message });
      else throw e;
    }
  }
  return issues;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
