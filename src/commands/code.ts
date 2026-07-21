// `code` — materialize, then launch the editor (§9.2).

import { ExitCode, usage } from "../lib/errors.ts";
import { parseFlags } from "../cli/flags.ts";
import { shellJoin } from "../lib/shell.ts";
import { passthrough } from "../lib/proc.ts";
import { ensureWorkspace } from "../core/workspace.ts";
import { resolveEditor } from "../core/editor.ts";
import { templateVars, wsContext } from "../core/env.ts";
import type { WorkspaceInput } from "./types.ts";

export async function code(input: WorkspaceInput): Promise<number> {
  const { ctx, project, ref } = input;
  if (ctx.flags.json) throw usage("--json is not supported for 'code'");
  const flags = parseFlags(input.args, {
    bools: ["--fetch", "--setup", "--no-setup"],
    values: ["--editor"],
  });

  const { ws, dataDir } = await ensureWorkspace(ctx, project, ref, {
    setup: flags.bool("--setup"),
    fetch: flags.bool("--fetch"),
  });

  const editor = flags.value("--editor") ?? project.editor;
  const wc = wsContext(project, ws, dataDir);
  const launch = resolveEditor(editor, ws.path, templateVars(wc));

  if (ctx.flags.dryRun) {
    process.stdout.write(`${shellJoin(launch.argv)}\n`);
    return ExitCode.SUCCESS;
  }

  ctx.log.step(`opening in ${editor}`);
  if (!launch.wait) {
    await passthrough(launch.argv, { cwd: launch.cwd, detach: true });
    return ExitCode.SUCCESS;
  }
  return passthrough(launch.argv, { cwd: launch.cwd });
}
