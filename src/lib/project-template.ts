// Starter template `config add`/`edit` seeds when a project file is absent (§9.12).

/**
 * Build the seed TOML for a new project file. Only `repo` is uncommented;
 * every other field is a commented example, so the file is valid as-is (once
 * `defaults.root` is set) and becomes real after a single edit — swapping the
 * placeholder repo URL. Path fields are intentionally omitted from the active
 * body: they default to `{root}/<project>/{repo,trees}` (§5.4).
 */
export function defaultProjectTemplate(project: string): string {
  return [
    `# uxd project config for "${project}" — check with \`uxd config validate ${project}\``,
    `repo = "git@github.com:ORG/REPO.git"   # required`,
    ``,
    `# editor = "code"            # optional; $VISUAL/$EDITOR wins when unset`,
    `# default_command = "code"   # optional; default action for \`uxd ${project} <ref>\``,
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
