// `config path | edit | add | validate` (§9.12). `add` is an alias of `edit`.

import { existsSync } from "node:fs";
import { ExitCode, usage } from "../lib/errors.ts";
import { parseFlags } from "../cli/flags.ts";
import { passthrough } from "../lib/proc.ts";
import {
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
  const flags = parseFlags(input.args, {});
  const [sub, ...rest] = flags.positionals;

  switch (sub) {
    case undefined:
    case "path":
      return path(ctx.configDir);
    case "edit":
    case "add": // `add` is a discoverable alias of `edit` — both open the file (§9.12).
      return edit(input, rest[0]);
    case "validate":
      return validate(input, rest[0]);
    default:
      throw usage(`unknown config subcommand '${sub}'`, "expected: path | edit | add | validate");
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
