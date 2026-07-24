// `uxd setup` — create the config directory and scaffold the first project.
//
// First-run onboarding. Creates the config dir (exempt from the §5.1 existence
// guard), ensures a `defaults.root` so derived paths resolve, then walks the
// user through one project file. Every value is also accepted via a flag so the
// command runs non-interactively in CI:
//
//   uxd setup [--name <name>] [--repo <url>] [--root <dir>]
//             [--default-branch <branch>] [--force]
//
// Failure modes: an invalid/reserved name or empty repo → E_USAGE (nothing
// written); an existing project file → E_CONFIG unless --force; a missing value
// on a non-TTY with no flag → E_USAGE naming the flag to pass. --dry-run prints
// the planned writes and changes nothing.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExitCode, configError, usage } from "../lib/errors.ts";
import { parseFlags } from "../cli/flags.ts";
import { promptLine } from "../lib/prompt.ts";
import { isValidProjectName, loadDefaults, loadProject, projectFilePath } from "../config/load.ts";
import type { Ctx } from "../config/schema.ts";
import type { TopInput } from "./types.ts";

const DEFAULT_ROOT = "~/dev/uxd";

export async function setup(input: TopInput): Promise<number> {
  const { ctx } = input;
  const flags = parseFlags(input.args, {
    bools: ["--force"],
    values: ["--name", "--repo", "--root", "--default-branch"],
  });
  if (flags.positionals.length) {
    throw usage(`unexpected argument '${flags.positionals[0]}'`, "setup takes only flags");
  }

  const configDir = ctx.configDir;
  const dirExisted = existsSync(configDir);

  // ── Resolve the base root (needed so a minimal project file resolves). ──────
  const existingDefaults = dirExisted ? loadDefaults(configDir) : {};
  const rootAlreadySet = existingDefaults.root !== undefined;
  const root: string = rootAlreadySet
    ? existingDefaults.root!
    : ask(ctx, "Base directory for repos & worktrees", { flag: flags.value("--root"), fallback: DEFAULT_ROOT }) ??
      DEFAULT_ROOT;

  // ── Gather the project fields. ──────────────────────────────────────────────
  const name = required(
    ask(ctx, "Project name", { flag: flags.value("--name") }),
    "--name",
    "a project name",
  );
  if (!isValidProjectName(name)) {
    throw usage(
      `invalid project name '${name}'`,
      "must match ^[a-z0-9][a-z0-9._-]*$ and not be 'defaults' or 'seeds'",
    );
  }

  const projectFile = projectFilePath(configDir, name);
  if (existsSync(projectFile) && !flags.bool("--force")) {
    throw configError(
      `project '${name}' already exists`,
      `edit it with \`uxd config edit ${name}\`, choose another name, or pass --force`,
    );
  }

  const repo = required(
    ask(ctx, "Repository URL (git@… or https://…)", { flag: flags.value("--repo") }),
    "--repo",
    "a repository URL",
  );
  const branch = ask(ctx, "Default branch (blank = auto-detect)", { flag: flags.value("--default-branch") });

  // ── Compose file contents. ──────────────────────────────────────────────────
  const projectToml =
    [`repo = ${tomlString(repo)}`, ...(branch ? [`default_branch = ${tomlString(branch)}`] : [])].join("\n") + "\n";
  const defaultsFile = join(configDir, "defaults.toml");
  const willWriteDefaults = !rootAlreadySet;

  // ── --dry-run: print the plan, touch nothing. ───────────────────────────────
  if (ctx.flags.dryRun) {
    if (!dirExisted) process.stdout.write(`mkdir -p ${configDir}\n`);
    if (willWriteDefaults) process.stdout.write(`write ${defaultsFile}\n  root = ${tomlString(root)}\n`);
    process.stdout.write(`write ${projectFile}\n${indent(projectToml)}`);
    return ExitCode.SUCCESS;
  }

  // ── Apply. ──────────────────────────────────────────────────────────────────
  if (!dirExisted) {
    mkdirSync(configDir, { recursive: true });
    ctx.log.step(`created config dir ${configDir}`);
  }
  if (willWriteDefaults) {
    appendDefaultsRoot(defaultsFile, root);
    ctx.log.step(`set defaults.root = ${root}`);
  }
  writeFileSync(projectFile, projectToml);
  ctx.log.step(`scaffolded ${name}.toml`);

  // Validate the freshly written config so a bad combination fails loudly here
  // rather than on the user's next command.
  loadProject(configDir, name, loadDefaults(configDir));

  ctx.log.step(`next: uxd ${name} ${branch ?? "<branch|pr|path>"}`);
  return ExitCode.SUCCESS;
}

/** Return the flag value, else prompt on a TTY, else the fallback (if any). */
function ask(ctx: Ctx, message: string, opts: { flag?: string; fallback?: string }): string | undefined {
  if (opts.flag !== undefined) return opts.flag.trim() || opts.fallback;
  if (ctx.flags.yes) return opts.fallback;
  if (!process.stdin.isTTY) return opts.fallback;

  const suffix = opts.fallback ? ` [${opts.fallback}]` : "";
  const line = promptLine(`${message}${suffix}:`);
  const trimmed = line?.trim() ?? "";
  return trimmed || opts.fallback;
}

/** Assert a gathered value is present, else a targeted usage error. */
function required(value: string | undefined, flag: string, what: string): string {
  if (value && value.trim()) return value.trim();
  throw usage(`missing ${what}`, `pass ${flag} or run interactively on a terminal`);
}

/** Append `root = …` to defaults.toml (creating it). Safe: defaults has no tables. */
function appendDefaultsRoot(file: string, root: string): void {
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const base = existing && !existing.endsWith("\n") ? existing + "\n" : existing;
  writeFileSync(file, `${base}root = ${tomlString(root)}\n`);
}

/** Minimal TOML basic-string encoder for the values we write (paths, URLs, refs). */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function indent(block: string): string {
  return block
    .split("\n")
    .map((l) => (l ? `  ${l}` : l))
    .join("\n");
}
