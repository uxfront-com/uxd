// Usage + version text (§4.4). Printed to stdout; always exit 0.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function version(): string {
  // package.json sits two levels up from src/cli/.
  const file = join(import.meta.dir, "..", "..", "package.json");
  if (existsSync(file)) {
    try {
      return (JSON.parse(readFileSync(file, "utf8")) as { version?: string }).version ?? "0.0.0";
    } catch {
      // fall through
    }
  }
  return "0.0.0";
}

export const HELP = `uxd — materialize any git ref of a configured project into a runnable workspace

USAGE
  uxd <project> <ref> [verb] [flags] [-- passthrough]
  uxd <project> [list|clean] [flags]
  uxd <top-level-verb> [args]

REF FORMS
  <branch>            a branch name (fetched from origin)
  <n> | #<n> | pr/<n> a pull request
  <path> | ~/path     adopt an existing working tree
  -                   the last-used ref for this project

WORKSPACE VERBS
  checkout            materialize only; print the worktree path (default for scripts)
  code                open the workspace in your editor
  info                show one workspace's details
  rm                  remove one workspace
  run|exec|shell|sync process verbs (M1)
  diff                show PR diff (M2)

PROJECT VERBS
  list                list a project's workspaces (default for bare \`uxd <project>\`)
  clean               remove workspaces (explicit slugs or --all)

TOP-LEVEL VERBS
  projects            list configured projects
  doctor              diagnose environment & configs
  config              path | edit [project] | add [project] | validate [project]
  completions         shell completions (M2)
  help                this text
  version             print version

GLOBAL FLAGS
  --config-dir <dir>  override the config directory
  --pr|--branch|--path <v>  force ref interpretation
  --dry-run           print what would run; change nothing
  --json              machine-readable stdout (checkout, list, info, projects, doctor)
  -q, --quiet         suppress step logs
  -v, --verbose       print external commands
  -y, --yes           assume yes for prompts
  --no-color          disable ANSI color

Config dir: --config-dir → $UXD_CONFIG_DIR → ~/.uxd
`;
