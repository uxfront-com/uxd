// Config discovery, TOML parse, defaults merge, aggregate error reporting (§5).

import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { isAbsolute, join, relative, sep } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { UxdError } from "../lib/errors.ts";
import { resolvePath } from "../lib/paths.ts";
import { fnv1a32 } from "../lib/hash.ts";
import {
  RawDefaultsSchema,
  RawProjectSchema,
  type Defaults,
  type ProjectConfig,
} from "./schema.ts";
import { DEFAULT_COMMAND_VERBS } from "../cli/verbs.ts";

const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const RESERVED_NAMES = new Set(["defaults", "seeds"]);

export interface ConfigIssue {
  file: string;
  path: string;
  message: string;
}

export class ConfigValidationError extends UxdError {
  readonly issues: ConfigIssue[];
  constructor(issues: ConfigIssue[]) {
    const body = issues.map((i) => `${i.file}: ${i.path}: ${i.message}`).join("\n");
    super("E_CONFIG", body);
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
 */
export function loadProject(configDir: string, name: string, defaults: Defaults): ProjectConfig {
  const label = `${name}.toml`;
  const file = projectFilePath(configDir, name);

  if (!PROJECT_NAME_RE.test(name)) {
    throw new ConfigValidationError([
      { file: label, path: "(name)", message: `invalid project name; must match ${PROJECT_NAME_RE}` },
    ]);
  }
  if (!existsSync(file)) {
    throw new UxdError("E_CONFIG", `unknown project '${name}'`, {
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
  const p = parsed.data;

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
        file: label,
        path: `setup.seed_files.${i}`,
        message: `must be a relative path with no '..' segments (got '${rel}')`,
      });
    }
  });

  // ── default_command validation (§5.4). ────────────────────────────────────
  const commandNames = Object.keys(p.commands ?? {});
  const defaultCommand = p.default_command ?? defaults.defaultCommand ?? "code";
  const validTargets = new Set<string>([...DEFAULT_COMMAND_VERBS, ...commandNames]);
  if (!validTargets.has(defaultCommand)) {
    issues.push({
      file: label,
      path: "default_command",
      message: `unknown command '${defaultCommand}'; expected a verb or one of [${commandNames.join(", ")}]`,
    });
  }

  if (issues.length) throw new ConfigValidationError(issues);

  const commands: ProjectConfig["commands"] = {};
  for (const [cname, c] of Object.entries(p.commands ?? {})) {
    commands[cname] = { run: c.run, cwd: c.cwd, env: c.env ?? {} };
  }

  return {
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
}

/** Validate every project (and defaults) for `config validate`; returns all issues. */
export function validateAll(configDir: string): ConfigIssue[] {
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
      loadProject(configDir, name, defaults);
    } catch (e) {
      if (e instanceof ConfigValidationError) issues.push(...e.issues);
      else if (e instanceof UxdError) issues.push({ file: `${name}.toml`, path: "(root)", message: e.message });
      else throw e;
    }
  }
  return issues;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
