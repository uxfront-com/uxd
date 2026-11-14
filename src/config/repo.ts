// A repo's own `.testlane.toml` (§5.7): parse + validate the text, and merge it
// under the user's project file. Pure — no git, no state, no filesystem.

import { parse as parseToml } from "smol-toml";
import { RawRepoSchema, USER_ONLY_MESSAGE, type RawProject, type RawRepo } from "./schema.ts";
import { ConfigValidationError } from "./load.ts";
import { printableLine, printableLines } from "../lib/printable.ts";

/** The file a repo commits at its root. */
export const REPO_FILE = ".testlane.toml";

/** How issues and prompts name a project's repo file, e.g. `app:.testlane.toml`. */
export function repoLabel(project: string): string {
  return `${project}:${REPO_FILE}`;
}

/**
 * Parse and validate a repo file's text. Every issue is reported at once, in
 * the `config validate` format, labelled with `repoLabel(project)` (§5.4).
 */
export function parseRepoConfig(project: string, text: string): RawRepo {
  const file = repoLabel(project);
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (e) {
    // The parser quotes the file's lines, and nothing in it is approved yet (§5.7).
    const message = printableLines(`TOML parse error: ${(e as Error).message}`);
    throw new ConfigValidationError([{ file, path: "(root)", message }]);
  }
  const parsed = RawRepoSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigValidationError(
      parsed.error.issues.map((issue) => ({
        file,
        // Keys and messages can quote the file, so escape what a terminal would act on.
        path: printableLine(issue.path.length ? issue.path.join(".") : "(root)"),
        message: printableLine(
          issue.message === USER_ONLY_MESSAGE ? issue.message.replace("<project>", project) : issue.message,
        ),
      })),
    );
  }
  return parsed.data;
}

/** Where an effective key's value came from (§5.7). */
export type KeySource = "user" | "repo" | "default";

export interface MergedRaw {
  raw: RawProject;
  /** Dotted key → source, for every key either file sets. */
  sources: Record<string, KeySource>;
}

/**
 * Merge a repo layer under the user's file (§5.7). The user file wins:
 * scalars and arrays are replaced, `[env]` and `[commands]` merge by key (a
 * user command replaces the whole repo command), `[hooks]` merge per hook.
 */
export function mergeRaw(user: RawProject, repo?: RawRepo): MergedRaw {
  const sources: Record<string, KeySource> = {};
  const pick = <T>(key: string, u: T | undefined, r: T | undefined): T | undefined => {
    if (u !== undefined) {
      sources[key] = "user";
      return u;
    }
    if (r !== undefined) {
      sources[key] = "repo";
      return r;
    }
    return undefined;
  };
  const table = <T>(prefix: string, u?: Record<string, T>, r?: Record<string, T>): Record<string, T> | undefined => {
    if (u === undefined && r === undefined) return undefined;
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(r ?? {})) {
      out[k] = v;
      sources[`${prefix}.${k}`] = "repo";
    }
    for (const [k, v] of Object.entries(u ?? {})) {
      out[k] = v;
      sources[`${prefix}.${k}`] = "user";
    }
    return out;
  };

  const raw: RawProject = { repo: user.repo };
  sources.repo = "user";
  const set = <K extends keyof RawProject>(key: K, value: RawProject[K] | undefined): void => {
    if (value !== undefined) raw[key] = value;
  };
  set("repo_path", pick("repo_path", user.repo_path, undefined));
  set("worktrees_path", pick("worktrees_path", user.worktrees_path, undefined));
  set("default_branch", pick("default_branch", user.default_branch, undefined));
  set("editor", pick("editor", user.editor, undefined));
  set("default_command", pick("default_command", user.default_command, repo?.default_command));
  set("ports", pick("ports", user.ports, repo?.ports));
  set("base_port", pick("base_port", user.base_port, undefined));

  if (user.setup !== undefined || repo?.setup !== undefined) {
    const setup: NonNullable<RawProject["setup"]> = {};
    const run = pick("setup.run", user.setup?.run, repo?.setup?.run);
    const cacheKey = pick("setup.cache_key", user.setup?.cache_key, repo?.setup?.cache_key);
    const seedFiles = pick("setup.seed_files", user.setup?.seed_files, repo?.setup?.seed_files);
    const seedFrom = pick("setup.seed_from", user.setup?.seed_from, undefined);
    if (run !== undefined) setup.run = run;
    if (cacheKey !== undefined) setup.cache_key = cacheKey;
    if (seedFiles !== undefined) setup.seed_files = seedFiles;
    if (seedFrom !== undefined) setup.seed_from = seedFrom;
    raw.setup = setup;
  }

  set("env", table("env", user.env, repo?.env));
  set("commands", table("commands", user.commands, repo?.commands));
  set("hooks", table("hooks", user.hooks, repo?.hooks));

  return { raw, sources };
}
