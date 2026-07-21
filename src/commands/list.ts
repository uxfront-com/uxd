// `list` / `info` — enumerate workspaces (§9.8). M0: no PR-metadata columns.

import { existsSync } from "node:fs";
import { ExitCode } from "../lib/errors.ts";
import { loadState, type Workspace } from "../core/state.ts";
import { isDirty } from "../git/worktree.ts";
import { pad } from "../lib/table.ts";
import type { ProjectInput, WorkspaceInput } from "./types.ts";
import { slug as slugFor } from "../core/resolve.ts";

interface Row extends Workspace {
  dirty: boolean;
  missing: boolean;
}

async function computeRows(project: string): Promise<Row[]> {
  const state = loadState(project);
  const rows: Row[] = [];
  for (const ws of Object.values(state.workspaces)) {
    const missing = !existsSync(ws.path);
    const dirty = !missing && ws.kind !== "path" ? await isDirty(ws.path) : false;
    rows.push({ ...ws, dirty, missing });
  }
  rows.sort((a, b) => (a.lastUsedAt < b.lastUsedAt ? 1 : -1));
  return rows;
}

function status(r: Row): string {
  if (r.missing) return "missing";
  if (r.dirty) return "dirty";
  return "clean";
}

function age(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const d = Math.floor(ms / 86_400_000);
  if (d >= 1) return `${d}d`;
  const h = Math.floor(ms / 3_600_000);
  if (h >= 1) return `${h}h`;
  const m = Math.floor(ms / 60_000);
  return `${m}m`;
}

export async function list(input: ProjectInput): Promise<number> {
  const { ctx, project } = input;
  const rows = await computeRows(project.name);

  if (ctx.flags.json) {
    process.stdout.write(JSON.stringify(rows) + "\n");
    return ExitCode.SUCCESS;
  }

  if (rows.length === 0) {
    ctx.log.step(`no workspaces for '${project.name}'`);
    return ExitCode.SUCCESS;
  }

  const header = ["SLUG", "KIND", "BRANCH", "STATUS", "PORT", "AGE", "LAST USED"];
  const body = rows.map((r) => [
    r.slug,
    r.kind,
    r.kind === "path" ? "(adopted)" : (r.branch ?? "—"),
    status(r),
    r.ports[0] !== undefined ? String(r.ports[0]) : "—",
    age(r.createdAt),
    age(r.lastUsedAt),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  process.stdout.write(header.map((h, i) => pad(h, widths[i]!)).join("  ").trimEnd() + "\n");
  for (const row of body) {
    process.stdout.write(row.map((c, i) => pad(c, widths[i]!)).join("  ").trimEnd() + "\n");
  }
  return ExitCode.SUCCESS;
}

export async function info(input: WorkspaceInput): Promise<number> {
  const { ctx, project, ref } = input;
  const slug = slugFor(ref);
  const rows = await computeRows(project.name);
  const row = rows.find((r) => r.slug === slug);
  if (!row) {
    ctx.log.warn(`no workspace '${slug}' for '${project.name}'`);
    return ExitCode.RESOLVE;
  }
  if (ctx.flags.json) {
    process.stdout.write(JSON.stringify(row) + "\n");
    return ExitCode.SUCCESS;
  }
  const lines: [string, string][] = [
    ["slug", row.slug],
    ["kind", row.kind],
    ["ref", row.ref],
    ["branch", row.branch ?? "—"],
    ["path", row.path],
    ["ports", row.ports.join(",") || "—"],
    ["status", status(row)],
    ["created", row.createdAt],
    ["last used", row.lastUsedAt],
  ];
  for (const [k, v] of lines) process.stdout.write(`${k}: ${v}\n`);
  return ExitCode.SUCCESS;
}
