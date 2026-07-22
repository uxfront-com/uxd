// diff — show a workspace's changes (§9.7). PR + gh → `gh pr diff`; otherwise
// `git diff <merge-base>...HEAD` in the worktree. Pager is inherited from stdio.

import { existsSync } from "node:fs";
import { ExitCode, resolveError } from "../lib/errors.ts";
import { parseFlags } from "../cli/flags.ts";
import { capture, passthrough } from "../lib/proc.ts";
import { shellJoin } from "../lib/shell.ts";
import { loadState } from "../core/state.ts";
import { slug as slugFor } from "../core/resolve.ts";
import { ghRepoSlug, resolveLast } from "../core/workspace.ts";
import type { ProjectConfig } from "../config/schema.ts";
import type { WorkspaceInput } from "./types.ts";

export async function diff(input: WorkspaceInput): Promise<number> {
  const { ctx, project, ref } = input;
  const flags = parseFlags(input.args, { bools: ["--stat", "--tool"] });
  const stat = flags.bool("--stat");
  const tool = flags.bool("--tool");
  const extra = input.passthrough;

  const spec = resolveLast(project, ref);
  const slug = slugFor(spec);
  const state = loadState(project.name);
  const ws = state.workspaces[slug];
  if (!ws || !existsSync(ws.path)) {
    throw resolveError(`no workspace for '${slug}'`, "run `uxd <project> <ref> checkout` first");
  }

  // PR workspace + gh → let gh render against the real PR base (§9.7). `--tool`
  // wants a local difftool. `--stat` and any `-- <passthrough>` (e.g.
  // `--color-words`) are git-diff flags that `gh pr diff` rejects, so those also
  // force the local git path below. Plain `diff` on a PR still uses gh.
  const gitOnlyArgs = stat || extra.length > 0;
  if (ws.kind === "pr" && ws.number !== undefined && !tool && !gitOnlyArgs && (await ctx.gh.available())) {
    const repo = ghRepoSlug(project.repo);
    if (repo) {
      if (ctx.flags.dryRun) {
        process.stdout.write(shellJoin(["gh", "pr", "diff", String(ws.number), "--repo", repo]) + "\n");
        return ExitCode.SUCCESS;
      }
      return ctx.gh.prDiff(repo, ws.number, []);
    }
  }

  // Otherwise: diff the worktree against its merge-base with the default branch.
  const range = await diffRange(ctx.flags.dryRun ? "" : ws.path, project);
  const sub = tool ? "difftool" : "diff";
  const argv = ["git", "-C", ws.path, sub, ...(stat ? ["--stat"] : []), ...(range ? [range] : []), ...extra];

  if (ctx.flags.dryRun) {
    process.stdout.write(shellJoin(argv) + "\n");
    return ExitCode.SUCCESS;
  }
  return passthrough(argv);
}

/**
 * Compute the `<merge-base>...HEAD` range for a worktree (§9.7). Falls back to an
 * empty range (plain working-tree diff) when the default branch or merge-base is
 * unavailable, so diff still shows *something* useful.
 */
async function diffRange(worktreeDir: string, project: ProjectConfig): Promise<string> {
  if (!worktreeDir || !project.defaultBranch) return "";
  const res = await capture(
    ["git", "-C", worktreeDir, "merge-base", `origin/${project.defaultBranch}`, "HEAD"],
    { allowFailure: true },
  );
  const base = res.stdout.trim();
  return res.code === 0 && base ? `${base}...HEAD` : "";
}
