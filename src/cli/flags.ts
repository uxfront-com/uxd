// Minimal verb-local flag parser. Global flags are already stripped in parse.ts.

import { usage } from "../lib/errors.ts";

export interface FlagSpec {
  /** Boolean flags, e.g. "--fetch". */
  bools?: readonly string[];
  /** Value-taking flags, e.g. "--older-than". */
  values?: readonly string[];
}

export interface ParsedFlags {
  bool(name: string): boolean;
  value(name: string): string | undefined;
  positionals: string[];
}

export function parseFlags(args: string[], spec: FlagSpec): ParsedFlags {
  const bools = new Set(spec.bools ?? []);
  const values = new Set(spec.values ?? []);
  const boolOut = new Set<string>();
  const valueOut = new Map<string, string>();
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    if (!tok.startsWith("-") || tok === "-") {
      positionals.push(tok);
      continue;
    }
    const eq = tok.indexOf("=");
    const name = eq !== -1 ? tok.slice(0, eq) : tok;
    const inline = eq !== -1 ? tok.slice(eq + 1) : undefined;

    if (bools.has(name)) {
      boolOut.add(name);
    } else if (values.has(name)) {
      if (inline !== undefined) {
        valueOut.set(name, inline);
      } else {
        const next = args[i + 1];
        if (next === undefined) throw usage(`flag ${name} requires a value`);
        valueOut.set(name, next);
        i += 1;
      }
    } else {
      throw usage(`unknown flag '${name}'`);
    }
  }

  return {
    bool: (n) => boolOut.has(n),
    value: (n) => valueOut.get(n),
    positionals,
  };
}
