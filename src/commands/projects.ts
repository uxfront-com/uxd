// `projects` — list configured projects (§9.10).

import { existsSync } from "node:fs";
import { ExitCode } from "../lib/errors.ts";
import { pad } from "../lib/table.ts";
import { listProjectNames, loadDefaults, loadProject } from "../config/load.ts";
import { loadState } from "../core/state.ts";
import type { TopInput } from "./types.ts";

export async function projects(input: TopInput): Promise<number> {
  const { ctx } = input;
  const defaults = loadDefaults(ctx.configDir);
  const names = listProjectNames(ctx.configDir);

  const rows = names.map((name) => {
    let repo = "?";
    let repoExists = false;
    try {
      const p = loadProject(ctx.configDir, name, defaults);
      repo = p.repo;
      repoExists = existsSync(p.repoPath);
    } catch {
      // Invalid config still lists by name; `doctor`/`config validate` explain.
    }
    let count = 0;
    try {
      count = Object.keys(loadState(name).workspaces).length;
    } catch {
      // ignore state errors here
    }
    return { name, repo, workspaces: count, pathExists: repoExists };
  });

  if (ctx.flags.json) {
    process.stdout.write(JSON.stringify(rows) + "\n");
    return ExitCode.SUCCESS;
  }

  if (rows.length === 0) {
    ctx.log.step(`no projects configured in ${ctx.configDir}`);
    return ExitCode.SUCCESS;
  }

  const header = ["NAME", "REPO", "WORKSPACES", "PATH-EXISTS"];
  const body = rows.map((r) => [r.name, r.repo, String(r.workspaces), r.pathExists ? "yes" : "no"]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  process.stdout.write(header.map((h, i) => pad(h, widths[i]!)).join("  ").trimEnd() + "\n");
  for (const row of body) {
    process.stdout.write(row.map((c, i) => pad(c, widths[i]!)).join("  ").trimEnd() + "\n");
  }
  return ExitCode.SUCCESS;
}
