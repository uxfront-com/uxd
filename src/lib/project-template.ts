// Starter template `config add`/`edit` seeds when a project file is absent (§9.12).

/**
 * Build the seed TOML for a new project file. Only `repo` is uncommented;
 * every other field is a commented example, so the file is valid as-is (once
 * `defaults.root` is set) and becomes real after a single edit — swapping the
 * placeholder repo URL. `config add <url>` passes the real `repo` instead. Path fields are intentionally omitted from the active
 * body: they default to `{root}/<project>/{repo,trees}` (§5.4).
 */
export function defaultProjectTemplate(project: string, repo?: string): string {
  return [
    `# testlane project config for "${project}" — check with \`testlane config validate ${project}\``,
    `repo = ${repo === undefined ? `"git@github.com:ORG/REPO.git"` : tomlString(repo)}   # required`,
    ``,
    `# editor = "code"            # optional; $VISUAL/$EDITOR wins when unset`,
    `# default_command = "code"   # optional; default action for \`testlane ${project} <ref>\``,
    ``,
    `# repo_path / worktrees_path default to {root}/${project}/{repo,trees}.`,
    "# Set `root` in defaults.toml, or uncomment these to override:",
    `# repo_path = "/abs/path/to/repo"`,
    `# worktrees_path = "/abs/path/to/trees"`,
    ``,
    `# [setup]`,
    `# run = "pnpm install --frozen-lockfile"`,
    `# cache_key = ["pnpm-lock.yaml"]`,
    ``,
    `# [commands.dev]`,
    `# run = "pnpm dev"`,
    ``,
  ].join("\n");
}

/** Minimal TOML basic-string encoder for the values Testlane writes (paths, URLs, refs). */
export function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
