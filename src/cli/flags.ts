// Minimal verb-local flag parser. Global flags are already stripped in parse.ts.

import { usage } from "../lib/errors.ts";

export interface FlagSpec {
  /** Boolean flags, e.g. "--fetch". */
  bools?: readonly string[];
  /** Value-taking flags, e.g. "--older-than". */
  values?: readonly string[];
  /** Repeatable value-taking flags, e.g. "--env" (collected in order). */
  multi?: readonly string[];
}

export interface ParsedFlags {
  bool(name: string): boolean;
  value(name: string): string | undefined;
  /** All values for a repeatable flag, in the order they appeared. */
  list(name: string): string[];
  positionals: string[];
}

export function parseFlags(args: string[], spec: FlagSpec): ParsedFlags {
  const bools = new Set(spec.bools ?? []);
  const values = new Set(spec.values ?? []);
  const multi = new Set(spec.multi ?? []);
  const boolOut = new Set<string>();
  const valueOut = new Map<string, string>();
  const multiOut = new Map<string, string[]>();
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

    const takeValue = (): string => {
      if (inline !== undefined) return inline;
      const next = args[i + 1];
      if (next === undefined) throw usage(`flag ${name} requires a value`);
      i += 1;
      return next;
    };

    if (bools.has(name)) {
      boolOut.add(name);
    } else if (values.has(name)) {
      valueOut.set(name, takeValue());
    } else if (multi.has(name)) {
      const acc = multiOut.get(name) ?? [];
      acc.push(takeValue());
      multiOut.set(name, acc);
    } else {
      throw usage(`unknown flag '${name}'`);
    }
  }

  return {
    bool: (n) => boolOut.has(n),
    value: (n) => valueOut.get(n),
    list: (n) => multiOut.get(n) ?? [],
    positionals,
  };
}
