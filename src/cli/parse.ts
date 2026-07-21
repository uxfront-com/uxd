// Tokenizer + argument classification algorithm (§4.3). Hand-rolled by design.

import { usage, resolveError, configError } from "../lib/errors.ts";
import type { GlobalFlags } from "../config/schema.ts";
import {
  isProjectVerb,
  isTopLevelVerb,
  isWorkspaceVerb,
  type ProjectVerb,
  type TopLevelVerb,
  type WorkspaceVerb,
} from "./verbs.ts";
import { parseRef, refFromDisambiguator, type RefSpec } from "../core/resolve.ts";

export type ParseResult =
  | { kind: "top"; verb: TopLevelVerb; args: string[]; global: GlobalFlags }
  | { kind: "project"; project: string; verb: ProjectVerb; args: string[]; global: GlobalFlags }
  | {
      kind: "workspace";
      project: string;
      ref: RefSpec;
      verb: WorkspaceVerb;
      /** Set when the verb was reached via command-name sugar (§4.3 step 5). */
      commandName?: string;
      args: string[];
      passthrough: string[];
      global: GlobalFlags;
    };

export interface ParseDeps {
  projectExists(name: string): boolean;
  /** Match a URL to a configured project, extracting an embedded ref if present. */
  resolveUrlProject(url: string): { project: string; ref?: RefSpec } | null;
  projectCommandNames(project: string): string[];
  projectDefaultCommand(project: string): string;
  knownProjects(): string[];
}

type Disambiguator = { kind: "pr" | "branch" | "path"; value: string };

const GLOBAL_VALUE_FLAGS = new Set(["--config-dir", "--pr", "--branch", "--path"]);

function isFlag(tok: string): boolean {
  return tok.startsWith("-") && tok !== "-";
}

function emptyGlobals(): GlobalFlags {
  return { dryRun: false, json: false, quiet: false, verbose: false, yes: false, noColor: false };
}

interface Extracted {
  global: GlobalFlags;
  disambiguator?: Disambiguator;
  rest: string[];
}

/** Pull global flags + ref disambiguators out of the pre-`--` tokens (§4.5). */
function extractFlags(pre: string[]): Extracted {
  const global = emptyGlobals();
  const rest: string[] = [];
  let disambiguator: Disambiguator | undefined;

  for (let i = 0; i < pre.length; i++) {
    const tok = pre[i]!;
    const eq = tok.indexOf("=");
    const name = tok.startsWith("--") && eq !== -1 ? tok.slice(0, eq) : tok;
    const inlineVal = tok.startsWith("--") && eq !== -1 ? tok.slice(eq + 1) : undefined;

    const takeValue = (): string => {
      if (inlineVal !== undefined) return inlineVal;
      const next = pre[i + 1];
      if (next === undefined) throw usage(`flag ${name} requires a value`);
      i += 1;
      return next;
    };

    switch (name) {
      case "--config-dir":
        global.configDir = takeValue();
        break;
      case "--dry-run":
        global.dryRun = true;
        break;
      case "--json":
        global.json = true;
        break;
      case "--quiet":
      case "-q":
        global.quiet = true;
        break;
      case "--verbose":
      case "-v":
        global.verbose = true;
        break;
      case "--yes":
      case "-y":
        global.yes = true;
        break;
      case "--no-color":
        global.noColor = true;
        break;
      case "--pr":
      case "--branch":
      case "--path": {
        if (disambiguator) throw usage("only one ref disambiguator (--pr/--branch/--path) may be given");
        const kind = name.slice(2) as Disambiguator["kind"];
        disambiguator = { kind, value: takeValue() };
        break;
      }
      default:
        if (GLOBAL_VALUE_FLAGS.has(name)) {
          // Unreachable — kept for exhaustiveness if the set grows.
          throw usage(`flag ${name} requires a value`);
        }
        rest.push(tok);
    }
  }

  return { global, disambiguator, rest };
}

export function parse(argv: string[], deps: ParseDeps): ParseResult {
  // 1. Tokenize: first bare `--` ends uxd parsing.
  const dashIdx = argv.indexOf("--");
  const pre = dashIdx === -1 ? argv : argv.slice(0, dashIdx);
  const passthrough = dashIdx === -1 ? [] : argv.slice(dashIdx + 1);

  // 2. Global flags anywhere before the verb.
  const { global, disambiguator, rest } = extractFlags(pre);

  // Nothing but flags → show help.
  if (rest.length === 0) {
    if (disambiguator) throw usage("ref disambiguators are only valid for workspace commands");
    return { kind: "top", verb: "help", args: [], global };
  }

  const p0 = rest[0]!;
  if (isFlag(p0)) throw usage(`unexpected flag '${p0}' before a command`);

  // 3a. Top-level verb.
  if (isTopLevelVerb(p0)) {
    if (disambiguator) throw usage("ref disambiguators are only valid for workspace commands");
    return { kind: "top", verb: p0, args: rest.slice(1), global };
  }

  // 3b. URL form.
  if (/^https?:\/\//.test(p0) || /^git@/.test(p0)) {
    const match = deps.resolveUrlProject(p0);
    if (!match) {
      throw resolveError(`no configured project matches URL '${p0}'`, `configured projects: ${deps.knownProjects().join(", ") || "(none)"}`);
    }
    let ref: RefSpec;
    let idx = 1;
    if (disambiguator) {
      ref = refFromDisambiguator(disambiguator.kind, disambiguator.value);
    } else if (match.ref) {
      ref = match.ref;
    } else {
      const next = rest[idx];
      if (next === undefined) throw usage(`URL '${p0}' has no ref; provide one (e.g. a PR number or branch)`);
      ref = parseRef(next);
      idx += 1;
    }
    return classifyWorkspace(match.project, ref, rest, idx, passthrough, global, deps);
  }

  // 3c. Plain project name.
  if (!deps.projectExists(p0)) {
    const known = deps.knownProjects();
    const suggestion = nearest(p0, known);
    throw configError(
      `unknown project '${p0}'`,
      `known projects: ${known.join(", ") || "(none)"}${suggestion ? ` — did you mean '${suggestion}'?` : ""}`,
    );
  }
  const project = p0;

  // Disambiguator replaces the ref positional; p1 becomes the verb slot.
  if (disambiguator) {
    const ref = refFromDisambiguator(disambiguator.kind, disambiguator.value);
    return classifyWorkspace(project, ref, rest, 1, passthrough, global, deps);
  }

  // 4. Positional 1.
  const p1 = rest[1];
  if (p1 === undefined || isFlag(p1)) {
    // bare `uxd <project>` ≡ `list`; leftover flags belong to list.
    return { kind: "project", project, verb: "list", args: rest.slice(1), global };
  }
  if (isProjectVerb(p1)) {
    return { kind: "project", project, verb: p1, args: rest.slice(2), global };
  }
  const ref = parseRef(p1);
  return classifyWorkspace(project, ref, rest, 2, passthrough, global, deps);
}

// 5. Positional 2: verb / command-name sugar / default_command.
function classifyWorkspace(
  project: string,
  ref: RefSpec,
  rest: string[],
  idx: number,
  passthrough: string[],
  global: GlobalFlags,
  deps: ParseDeps,
): ParseResult {
  const p2 = rest[idx];
  let verbStr: string;
  let argsStart: number;

  if (p2 === undefined || isFlag(p2)) {
    verbStr = deps.projectDefaultCommand(project);
    argsStart = idx; // any leftover flags belong to the default verb
  } else {
    verbStr = p2;
    argsStart = idx + 1;
  }

  if (isWorkspaceVerb(verbStr)) {
    return {
      kind: "workspace",
      project,
      ref,
      verb: verbStr,
      args: rest.slice(argsStart),
      passthrough,
      global,
    };
  }

  const commands = deps.projectCommandNames(project);
  if (commands.includes(verbStr)) {
    // Sugar → run <verbStr>.
    return {
      kind: "workspace",
      project,
      ref,
      verb: "run",
      commandName: verbStr,
      args: [verbStr, ...rest.slice(argsStart)],
      passthrough,
      global,
    };
  }

  throw usage(
    `unknown command '${verbStr}'`,
    `did you mean 'run ${verbStr}'? configured commands: ${commands.join(", ") || "(none)"}`,
  );
}

// Levenshtein-based nearest name (edit distance ≤ 2), for project suggestions.
function nearest(input: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDist = 3;
  for (const c of candidates) {
    const d = levenshtein(input, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return bestDist <= 2 ? best : undefined;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j]!;
  }
  return prev[n]!;
}
