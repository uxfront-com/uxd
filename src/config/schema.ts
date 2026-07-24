// Zod schemas for raw config files + resolved runtime types (§5.4, §15.2).

import { z } from "zod";
import type { Logger } from "../lib/log.ts";
import type { GhClient } from "../git/gh.ts";

// ── Raw file schemas (what smol-toml hands us) ──────────────────────────────

const commandName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9:_-]*$/, "must match ^[a-z0-9][a-z0-9:_-]*$");

const envTable = z.record(z.string(), z.string());

export const RawCommandSchema = z
  .object({
    run: z.string(),
    cwd: z.string().optional(),
    env: envTable.optional(),
  })
  .strict();

const HOOK_NAMES = ["post_checkout", "pre_run", "post_sync", "pre_clean"] as const;

export const RawHooksSchema = z
  .object({
    post_checkout: z.string().optional(),
    pre_run: z.string().optional(),
    post_sync: z.string().optional(),
    pre_clean: z.string().optional(),
  })
  .strict();

export const RawSetupSchema = z
  .object({
    run: z.string().optional(),
    cache_key: z.array(z.string()).optional(),
    seed_files: z.array(z.string()).optional(),
    seed_from: z.string().optional(),
  })
  .strict();

export const RawProjectSchema = z
  .object({
    extends: z.string().min(1).optional(),
    repo: z.string().min(1),
    repo_path: z.string().optional(),
    worktrees_path: z.string().optional(),
    default_branch: z.string().optional(),
    editor: z.string().optional(),
    default_command: z.string().optional(),
    ports: z.number().int().min(1).max(10).optional(),
    base_port: z.number().int().min(1024).max(65000).optional(),
    setup: RawSetupSchema.optional(),
    env: envTable.optional(),
    commands: z.record(commandName, RawCommandSchema).optional(),
    hooks: RawHooksSchema.optional(),
  })
  .strict();

export const RawDefaultsSchema = z
  .object({
    root: z.string().optional(),
    editor: z.string().optional(),
    default_command: z.string().optional(),
  })
  .strict();

export type RawProject = z.infer<typeof RawProjectSchema>;
export type RawDefaults = z.infer<typeof RawDefaultsSchema>;

export const HOOK_KEYS = HOOK_NAMES;

// ── Resolved runtime types (§15.2) ──────────────────────────────────────────

export interface Defaults {
  root?: string;
  editor?: string;
  defaultCommand?: string;
}

export interface CommandConfig {
  run: string;
  cwd?: string;
  env: Record<string, string>;
}

export interface ProjectConfig {
  name: string;
  repo: string;
  repoPath: string; // resolved, absolute
  worktreesPath: string; // resolved, absolute
  defaultBranch?: string;
  editor: string;
  defaultCommand: string;
  ports: number;
  basePort: number;
  setup: { run?: string; cacheKey: string[]; seedFiles: string[]; seedFrom?: string };
  env: Record<string, string>;
  commands: Record<string, CommandConfig>;
  hooks: Partial<Record<(typeof HOOK_NAMES)[number], string>>;
}

export interface GlobalFlags {
  configDir?: string;
  dryRun: boolean;
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  yes: boolean;
  noColor: boolean;
}

export interface Ctx {
  configDir: string;
  defaults: Defaults;
  flags: GlobalFlags;
  log: Logger;
  gh: GhClient;
}
