// Command input shapes threaded from main dispatch.

import type { Ctx, ProjectConfig } from "../config/schema.ts";
import type { RefSpec } from "../core/resolve.ts";

export interface TopInput {
  ctx: Ctx;
  args: string[];
}

export interface ProjectInput {
  ctx: Ctx;
  project: ProjectConfig;
  args: string[];
}

export interface WorkspaceInput {
  ctx: Ctx;
  project: ProjectConfig;
  ref: RefSpec;
  args: string[];
  passthrough: string[];
  commandName?: string;
}
