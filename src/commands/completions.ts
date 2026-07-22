// `completions <bash|zsh|fish>` — print a static shell completion script (§9.13).
// Top-level/project/workspace verbs and the current project names are baked in
// at generation time; workspace slugs are completed dynamically by shelling out
// to `uxd <project> list --json` from the emitted script.

import { ExitCode, usage } from "../lib/errors.ts";
import { listProjectNames } from "../config/load.ts";
import { TOP_LEVEL_VERBS, PROJECT_VERBS, WORKSPACE_VERBS } from "../cli/verbs.ts";
import type { TopInput } from "./types.ts";

type Shell = "bash" | "zsh" | "fish";

export async function completions(input: TopInput): Promise<number> {
  const { ctx } = input;
  const shell = input.args[0];
  if (shell === undefined) {
    throw usage("completions requires a shell", "one of: bash, zsh, fish");
  }
  if (shell !== "bash" && shell !== "zsh" && shell !== "fish") {
    throw usage(`unsupported shell '${shell}'`, "one of: bash, zsh, fish");
  }

  const projects = listProjectNames(ctx.configDir);
  const script = render(shell, projects);
  process.stdout.write(script);
  return ExitCode.SUCCESS;
}

/** Verb vocabularies baked into the script, space-joined for the shell word lists. */
const TOP = TOP_LEVEL_VERBS.join(" ");
const PROJECT = PROJECT_VERBS.join(" ");
const WORKSPACE = WORKSPACE_VERBS.join(" ");

function render(shell: Shell, projects: string[]): string {
  if (shell === "bash") return bash(projects);
  if (shell === "zsh") return zsh(projects);
  return fish(projects);
}

/**
 * bash: a single `complete -F` function. Position 1 is a top-level verb or a
 * project name; after a project, offer project+workspace verbs plus the live
 * workspace slugs from `uxd <project> list --json`.
 */
function bash(projects: string[]): string {
  const projWords = projects.join(" ");
  return `# uxd bash completion — eval "$(uxd completions bash)"
_uxd() {
  local cur prev words cword
  _init_completion &>/dev/null || {
    cur="\${COMP_WORDS[COMP_CWORD]}"
    words=("\${COMP_WORDS[@]}")
    cword=$COMP_CWORD
  }
  local top="${TOP}"
  local projects="${projWords}"
  local pverbs="${PROJECT} ${WORKSPACE}"

  if [ "$cword" -le 1 ]; then
    COMPREPLY=($(compgen -W "$top $projects" -- "$cur"))
    return
  fi

  local project="\${words[1]}"
  case " $projects " in
    *" $project "*)
      local slugs
      slugs=$(uxd "$project" list --json 2>/dev/null \\
        | grep -o '"slug":"[^"]*"' | sed 's/"slug":"//; s/"//')
      COMPREPLY=($(compgen -W "$pverbs $slugs" -- "$cur"))
      return
      ;;
  esac
  COMPREPLY=($(compgen -W "$pverbs" -- "$cur"))
}
complete -F _uxd uxd
`;
}

/**
 * zsh: a `#compdef`-style function driven by `compadd`. Same two-level model as
 * bash — top verbs/projects first, then project verbs + live slugs.
 */
function zsh(projects: string[]): string {
  const projWords = projects.join(" ");
  return `#compdef uxd
# uxd zsh completion — eval "$(uxd completions zsh)"
_uxd() {
  local -a top projects pverbs
  top=(${TOP})
  projects=(${projWords})
  pverbs=(${PROJECT} ${WORKSPACE})

  if (( CURRENT <= 2 )); then
    compadd -- $top $projects
    return
  fi

  local project="\${words[2]}"
  if (( \${projects[(I)$project]} )); then
    local -a slugs
    slugs=(\${(f)"$(uxd "$project" list --json 2>/dev/null \\
      | grep -o '"slug":"[^"]*"' | sed 's/"slug":"//; s/"//')"})
    compadd -- $pverbs $slugs
    return
  fi
  compadd -- $pverbs
}
_uxd "$@"
`;
}

/**
 * fish: per-condition `complete` rules. Slugs are produced by a helper function
 * that inspects `commandline` for the project token.
 */
function fish(projects: string[]): string {
  const projLines = projects.map((p) => `complete -c uxd -n '__fish_uxd_no_project' -a '${p}'`).join("\n");
  const topLine = `complete -c uxd -n '__fish_uxd_no_project' -a '${TOP}'`;
  return `# uxd fish completion — uxd completions fish | source
function __fish_uxd_no_project
  set -l toks (commandline -opc)
  test (count $toks) -le 1
end

function __fish_uxd_project
  set -l toks (commandline -opc)
  test (count $toks) -ge 2; and printf '%s' $toks[2]
end

function __fish_uxd_slugs
  set -l project (__fish_uxd_project)
  test -n "$project"; or return
  uxd "$project" list --json 2>/dev/null \\
    | string match -r -a '"slug":"[^"]*"' \\
    | string replace -r '"slug":"([^"]*)"' '$1'
end

${topLine}
${projLines}
complete -c uxd -n 'not __fish_uxd_no_project' -a '${PROJECT} ${WORKSPACE}'
complete -c uxd -n 'not __fish_uxd_no_project' -a '(__fish_uxd_slugs)'
`;
}
