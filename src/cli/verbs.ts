// Verb tables (§4.2). Shared by parse.ts and config validation.

export const TOP_LEVEL_VERBS = ["projects", "doctor", "config", "completions", "help", "version"] as const;

export const PROJECT_VERBS = ["list", "clean"] as const;

export const WORKSPACE_VERBS = [
  "checkout",
  "code",
  "run",
  "exec",
  "shell",
  "sync",
  "diff",
  "info",
  "rm",
] as const;

export type TopLevelVerb = (typeof TOP_LEVEL_VERBS)[number];
export type ProjectVerb = (typeof PROJECT_VERBS)[number];
export type WorkspaceVerb = (typeof WORKSPACE_VERBS)[number];

export function isTopLevelVerb(s: string): s is TopLevelVerb {
  return (TOP_LEVEL_VERBS as readonly string[]).includes(s);
}
export function isProjectVerb(s: string): s is ProjectVerb {
  return (PROJECT_VERBS as readonly string[]).includes(s);
}
export function isWorkspaceVerb(s: string): s is WorkspaceVerb {
  return (WORKSPACE_VERBS as readonly string[]).includes(s);
}

/** Verbs valid as a `default_command` target (before configured command names). */
export const DEFAULT_COMMAND_VERBS = ["checkout", "code", "shell", "diff", "info"] as const;
