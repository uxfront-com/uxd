// Hook execution (§12). A hook is a bash -c string with composed env, cwd = worktree.

import { interpolate } from "../lib/template.ts";
import { passthrough } from "../lib/proc.ts";
import { shellJoin } from "../lib/shell.ts";
import { setupError } from "../lib/errors.ts";
import type { Ctx, ProjectConfig } from "../config/schema.ts";
import { composeEnv, templateVars, type WorkspaceContext } from "./env.ts";

export type HookName = "post_checkout" | "pre_run" | "post_sync" | "pre_clean";

/**
 * Run a configured hook. `fatal` controls whether a non-zero exit aborts the
 * operation (exit 6) or only warns (§12).
 */
export async function runHook(
  ctx: Ctx,
  project: ProjectConfig,
  wc: WorkspaceContext,
  name: HookName,
  fatal: boolean,
): Promise<void> {
  const template = project.hooks[name];
  if (!template) return;

  const script = interpolate(template, templateVars(wc), `hooks.${name}`);
  if (ctx.flags.dryRun) {
    process.stdout.write(`${shellJoin(["bash", "-c", script])}\n`);
    return;
  }

  ctx.log.step(`hook ${name}`);
  const env = composeEnv(wc, project);
  const code = await passthrough(["bash", "-c", script], { cwd: wc.path, env });
  if (code !== 0 && fatal) {
    throw setupError(`hook ${name} failed (exit ${code})`);
  }
  if (code !== 0) ctx.log.warn(`hook ${name} exited ${code} (continuing)`);
}
