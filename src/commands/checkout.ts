// `checkout` — materialize only; print the worktree path (§9.1).

import { ExitCode } from "../lib/errors.ts";
import { parseFlags } from "../cli/flags.ts";
import { ensureWorkspace } from "../core/workspace.ts";
import type { WorkspaceInput } from "./types.ts";

export async function checkout(input: WorkspaceInput): Promise<number> {
  const { ctx, project, ref } = input;
  const flags = parseFlags(input.args, { bools: ["--fetch", "--setup", "--no-setup"] });

  const { ws, created } = await ensureWorkspace(ctx, project, ref, {
    setup: flags.bool("--setup"),
    fetch: flags.bool("--fetch"),
  });

  if (ctx.flags.json) {
    process.stdout.write(
      JSON.stringify({
        project: project.name,
        slug: ws.slug,
        ref: ws.ref,
        kind: ws.kind,
        branch: ws.branch ?? null,
        path: ws.path,
        ports: ws.ports,
        created,
      }) + "\n",
    );
  } else {
    // Stable stdout contract: the absolute worktree path, one line, nothing else.
    process.stdout.write(`${ws.path}\n`);
  }
  return ExitCode.SUCCESS;
}
