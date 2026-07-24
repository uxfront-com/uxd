// `config path | edit | add | link | validate` (§9.12). `add` is an alias of `edit`.

import { existsSync, writeFileSync } from "node:fs";
import { ExitCode, usage } from "../lib/errors.ts";
import { parseFlags } from "../cli/flags.ts";
import { passthrough } from "../lib/proc.ts";
import { resolvePath } from "../lib/paths.ts";
import {
  isValidProjectName,
  loadDefaults,
  loadProject,
  projectExists,
  projectFilePath,
  validateAll,
} from "../config/load.ts";
import { resolveEditor } from "../core/editor.ts";
import type { TopInput } from "./types.ts";

export async function config(input: TopInput): Promise<number> {
  const { ctx } = input;
  const flags = parseFlags(input.args, { values: ["--from"], bools: ["--force"] });
  const [sub, ...rest] = flags.positionals;

  switch (sub) {
    case undefined:
    case "path":
      return path(ctx.configDir);
    case "edit":
    case "add": // `add` is a discoverable alias of `edit` — both open the file (§9.12).
      return edit(input, rest[0]);
    case "link":
      return link(input, rest[0], flags.value("--from"), flags.bool("--force"));
    case "validate":
      return validate(input, rest[0]);
    default:
      throw usage(`unknown config subcommand '${sub}'`, "expected: path | edit | add | link | validate");
  }
}

function path(configDir: string): number {
  // `config path` works even when the dir is absent (§5.1).
  process.stdout.write(`${configDir}\n`);
  return ExitCode.SUCCESS;
}

async function edit(input: TopInput, project?: string): Promise<number> {
  const { ctx } = input;
  const target = project ? projectFilePath(ctx.configDir, project) : ctx.configDir;
  if (project && !projectExists(ctx.configDir, project) && !existsSync(target)) {
    ctx.log.warn(`creating new project file: ${target}`);
  }

  // Prefer the project's configured editor, then $VISUAL/$EDITOR, then a preset.
  let editor = process.env.VISUAL || process.env.EDITOR || "";
  if (project && projectExists(ctx.configDir, project)) {
    try {
      editor = loadProject(ctx.configDir, project, loadDefaults(ctx.configDir)).editor;
    } catch {
      // fall back to env editor for a broken file so the user can fix it
    }
  }
  if (!editor) editor = "vi";

  const launch = resolveEditor(editor, target, { path: target });
  if (ctx.flags.dryRun) {
    process.stdout.write(`${launch.argv.join(" ")}\n`);
    return ExitCode.SUCCESS;
  }
  // Config editing is always foreground (text editors); ignore preset wait hints.
  return passthrough(launch.argv, { cwd: launch.cwd });
}

/** `config link <name> --from <path>` — scaffold a pointer that `extends` a repo config. */
function link(input: TopInput, name: string | undefined, from: string | undefined, force: boolean): number {
  const { ctx } = input;
  if (!name) {
    throw usage("config link requires a project name", "usage: uxd config link <name> --from <path>");
  }
  if (!from) {
    throw usage("config link requires --from <path>", "path to the repo-committed uxd config file");
  }
  if (!isValidProjectName(name)) {
    throw usage(`invalid project name '${name}'`, "must match ^[a-z0-9][a-z0-9._-]*$ and not be a reserved name");
  }

  const target = projectFilePath(ctx.configDir, name);
  if (existsSync(target) && !force) {
    throw usage(`project '${name}' already exists`, `edit ${target}, or pass --force to overwrite`);
  }

  // Resolve to an absolute path so later loads are unambiguous regardless of CWD.
  const basePath = resolvePath(from);
  if (!existsSync(basePath)) {
    throw usage(
      `referenced config not found: ${basePath}`,
      "commit the uxd config in the repo, then link a stable clone path (not a worktree)",
    );
  }

  const body =
    `# uxd project '${name}' — pointer to a repo-committed config.\n` +
    `# Shared config lives in the referenced file; keep machine paths and secrets here.\n` +
    `extends = ${tomlString(basePath)}\n`;

  if (ctx.flags.dryRun) {
    process.stdout.write(body);
    return ExitCode.SUCCESS;
  }

  writeFileSync(target, body);

  // Validate the merged result so a broken link fails loudly now, not at first use.
  try {
    loadProject(ctx.configDir, name, loadDefaults(ctx.configDir));
  } catch (e) {
    ctx.log.warn(`linked ${target}, but the merged config is invalid: ${(e as Error).message}`);
    return ExitCode.CONFIG;
  }
  ctx.log.step(`linked ${name} → ${basePath}`);
  return ExitCode.SUCCESS;
}

/** Quote a string as a TOML basic string (escape backslash and double-quote). */
function tomlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function validate(input: TopInput, project?: string): number {
  const { ctx } = input;

  if (project) {
    if (!projectExists(ctx.configDir, project)) {
      throw usage(`unknown project '${project}'`, `no config file at ${projectFilePath(ctx.configDir, project)}`);
    }
    try {
      loadProject(ctx.configDir, project, loadDefaults(ctx.configDir));
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      return ExitCode.CONFIG;
    }
    ctx.log.step(`${project}: ok`);
    return ExitCode.SUCCESS;
  }

  const issues = validateAll(ctx.configDir);
  if (ctx.flags.json) {
    process.stdout.write(JSON.stringify({ ok: issues.length === 0, issues }) + "\n");
    return issues.length ? ExitCode.CONFIG : ExitCode.SUCCESS;
  }
  if (issues.length === 0) {
    ctx.log.step("all project configs valid");
    return ExitCode.SUCCESS;
  }
  for (const i of issues) process.stderr.write(`${i.file}: ${i.path}: ${i.message}\n`);
  return ExitCode.CONFIG;
}
