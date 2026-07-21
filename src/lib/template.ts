// Single-pass {name} interpolation (§5.5). `{{` escapes a literal `{`.

import { UxdError } from "./errors.ts";

export type TemplateVars = Record<string, string>;

/**
 * Interpolate `{name}` tokens against `vars` in a single left-to-right pass.
 * `{{` yields a literal `{`. An unknown `{name}` throws E_CONFIG at use time.
 * `where` is used only to make the error message point at the offending field.
 */
export function interpolate(input: string, vars: TemplateVars, where: string): string {
  let out = "";
  let i = 0;
  const n = input.length;

  while (i < n) {
    const ch = input[i]!;

    if (ch === "{") {
      // `{{` → literal `{`.
      if (input[i + 1] === "{") {
        out += "{";
        i += 2;
        continue;
      }
      const close = input.indexOf("}", i + 1);
      if (close === -1) {
        throw new UxdError("E_CONFIG", `${where}: unterminated '{' in template`);
      }
      const name = input.slice(i + 1, close);
      if (!(name in vars)) {
        throw new UxdError("E_CONFIG", `${where}: unknown template variable '{${name}}'`, {
          hint: `known variables: ${Object.keys(vars).sort().join(", ")}`,
        });
      }
      out += vars[name];
      i = close + 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/**
 * Build the template variable map for a materialized workspace (§5.5), including
 * `{port+N}` entries for N in [1, ports).
 */
export function workspaceVars(input: {
  path: string;
  repoPath: string;
  dataDir: string;
  project: string;
  ref: string;
  branch: string;
  slug: string;
  ports: number[];
}): TemplateVars {
  const first = input.ports[0];
  const vars: TemplateVars = {
    path: input.path,
    repo_path: input.repoPath,
    data_dir: input.dataDir,
    project: input.project,
    ref: input.ref,
    branch: input.branch,
    slug: input.slug,
    port: first !== undefined ? String(first) : "",
  };
  for (let n = 1; n < input.ports.length; n++) {
    vars[`port+${n}`] = String(input.ports[n]);
  }
  return vars;
}
