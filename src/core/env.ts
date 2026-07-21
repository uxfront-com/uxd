// UXD_* export vars + env composition (§5.5, §11.2).

import { interpolate, workspaceVars, type TemplateVars } from "../lib/template.ts";
import type { ProjectConfig } from "../config/schema.ts";
import type { Workspace } from "./state.ts";

export interface WorkspaceContext {
  path: string;
  repoPath: string;
  dataDir: string;
  project: string;
  ref: string;
  branch: string;
  slug: string;
  ports: number[];
}

export function wsContext(project: ProjectConfig, ws: Workspace, dataDir: string): WorkspaceContext {
  return {
    path: ws.path,
    repoPath: project.repoPath,
    dataDir,
    project: project.name,
    ref: ws.ref,
    branch: ws.branch ?? (ws.number !== undefined ? `pr/${ws.number}` : ws.slug),
    slug: ws.slug,
    ports: ws.ports,
  };
}

/** Template variables for {path}/{port}/… interpolation (§5.5). */
export function templateVars(wc: WorkspaceContext): TemplateVars {
  return workspaceVars(wc);
}

/** The always-exported UXD_* variables (§5.5). */
export function uxdEnv(wc: WorkspaceContext): Record<string, string> {
  const e: Record<string, string> = {
    UXD_PATH: wc.path,
    UXD_REPO_PATH: wc.repoPath,
    UXD_DATA_DIR: wc.dataDir,
    UXD_PROJECT: wc.project,
    UXD_REF: wc.ref,
    UXD_BRANCH: wc.branch,
    UXD_SLUG: wc.slug,
    UXD_PORT: wc.ports[0] !== undefined ? String(wc.ports[0]) : "",
  };
  for (let i = 1; i < wc.ports.length; i++) {
    e[`UXD_PORT_${i}`] = String(wc.ports[i]);
  }
  return e;
}

/**
 * Compose the environment for run/exec/shell/hooks (later wins, §11.2):
 * process.env → UXD_* → project [env] → command env → --env flags.
 */
export function composeEnv(
  wc: WorkspaceContext,
  project: ProjectConfig,
  extra?: { commandEnv?: Record<string, string>; flagEnv?: Record<string, string> },
): Record<string, string> {
  const vars = templateVars(wc);
  const out: Record<string, string> = { ...(process.env as Record<string, string>) };
  Object.assign(out, uxdEnv(wc));
  for (const [k, v] of Object.entries(project.env)) {
    out[k] = interpolate(v, vars, `env.${k}`);
  }
  if (extra?.commandEnv) {
    for (const [k, v] of Object.entries(extra.commandEnv)) {
      out[k] = interpolate(v, vars, `command.env.${k}`);
    }
  }
  if (extra?.flagEnv) Object.assign(out, extra.flagEnv);
  return out;
}
