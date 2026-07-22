// `list` / `info` — enumerate workspaces (§9.8). PR rows carry gh-derived
// STATUS (state + CI) refreshed stale-while-revalidate, bounded to 2s (§7.3).

import { existsSync } from "node:fs";
import { ExitCode, usage, resolveError } from "../lib/errors.ts";
import { parseFlags } from "../cli/flags.ts";
import { loadState, type Workspace } from "../core/state.ts";
import { isDirty } from "../git/worktree.ts";
import { workspaceDiskBytes } from "../core/remove.ts";
import { ghRepoSlug } from "../core/workspace.ts";
import { pad } from "../lib/table.ts";
import type { Ctx, ProjectConfig } from "../config/schema.ts";
import type { ProjectInput, WorkspaceInput } from "./types.ts";
import { slug as slugFor } from "../core/resolve.ts";

/** How old a cached PR metadata entry may be before `list` revalidates it. */
const PR_STALE_MS = 60_000;
/** Wall-clock budget for a single `list`'s gh refresh — render regardless (§7.3). */
const REFRESH_BUDGET_MS = 2_000;

type CiState = "pass" | "fail" | "pending" | null;

interface Row extends Workspace {
  dirty: boolean;
  missing: boolean;
  diskBytes?: number | null;
}

/** Fresh, in-memory-only PR facts gathered during a refresh (never persisted). */
interface FreshPr {
  state: string;
  ci: CiState;
}

async function computeRows(project: string, du: boolean): Promise<Row[]> {
  const state = loadState(project);
  const rows: Row[] = [];
  for (const ws of Object.values(state.workspaces)) {
    const missing = !existsSync(ws.path);
    const dirty = !missing && ws.kind !== "path" ? await isDirty(ws.path) : false;
    const row: Row = { ...ws, dirty, missing };
    if (du) row.diskBytes = await workspaceDiskBytes(ws.path);
    rows.push(row);
  }
  rows.sort((a, b) => (a.lastUsedAt < b.lastUsedAt ? 1 : -1));
  return rows;
}

/** True when a cached PR entry is absent or older than the stale window. */
function prStale(fetchedAt: string | undefined): boolean {
  if (!fetchedAt) return true;
  return Date.now() - new Date(fetchedAt).getTime() > PR_STALE_MS;
}

/**
 * Refresh stale PR metadata for display (§7.3). Best-effort and bounded: fires
 * `gh pr view` for each stale PR row and races the whole batch against a 2s
 * budget, returning whatever came back. gh-unavailable → empty (cached render).
 * Purely in-memory — the persisted cache is written on checkout, not here.
 */
async function refreshPrMeta(ctx: Ctx, project: ProjectConfig, rows: Row[]): Promise<Map<string, FreshPr>> {
  const fresh = new Map<string, FreshPr>();
  if (!(await ctx.gh.available())) return fresh;
  const repo = ghRepoSlug(project.repo);
  if (!repo) return fresh;

  const stale = rows.filter(
    (r) => r.kind === "pr" && r.number !== undefined && !r.missing && prStale(r.pr?.fetchedAt),
  );
  if (stale.length === 0) return fresh;

  const budget = new Promise<void>((res) => setTimeout(res, REFRESH_BUDGET_MS));
  const work = Promise.all(
    stale.map(async (r) => {
      const meta = await ctx.gh.prView(repo, r.number!);
      if (meta) fresh.set(r.slug, { state: meta.state, ci: meta.ci ?? null });
    }),
  );
  await Promise.race([work, budget]);
  return fresh;
}

function ciMark(ci: CiState): string {
  if (ci === "pass") return " ✓";
  if (ci === "fail") return " ✗";
  return "";
}

/** Compose the STATUS column: PR state + CI, plus dirty/missing (§9.8). */
function status(r: Row, fresh: Map<string, FreshPr>): string {
  if (r.missing) return "missing";
  const parts: string[] = [];
  if (r.kind === "pr") {
    const f = fresh.get(r.slug);
    const state = f?.state ?? r.pr?.state;
    if (state) parts.push(state.toLowerCase() + ciMark(f?.ci ?? null));
  }
  if (r.dirty) parts.push("dirty");
  if (parts.length === 0) parts.push("clean");
  return parts.join(" ");
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
  const flags = parseFlags(input.args, { bools: ["--du"] });
  const du = flags.bool("--du");
  const rows = await computeRows(project.name, du || ctx.flags.json);

  if (ctx.flags.json) {
    // JSON reflects persisted state entries plus computed fields — no gh refresh,
    // so output stays deterministic and offline-safe (§9.8).
    process.stdout.write(JSON.stringify(du ? rows : stripDisk(rows)) + "\n");
    return ExitCode.SUCCESS;
  }

  if (rows.length === 0) {
    ctx.log.step(`no workspaces for '${project.name}'`);
    return ExitCode.SUCCESS;
  }

  const fresh = await refreshPrMeta(ctx, project, rows);

  const header = ["SLUG", "KIND", "BRANCH", "STATUS", "PORT", "AGE", "LAST USED"];
  const body = rows.map((r) => [
    r.slug,
    r.kind,
    r.kind === "path" ? "(adopted)" : (r.branch ?? "—"),
    status(r, fresh),
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

/**
 * Interactive picker for bare `uxd <project>` on a TTY (§4.3/M2, built on the
 * same state as `list`). Non-interactive (no TTY) or `--json` degrades to a
 * plain `list`. On selection, prints the chosen workspace's path to stdout so it
 * composes with `cd "$(uxd <project>)"`; an empty answer cancels.
 */
export async function pick(input: ProjectInput): Promise<number> {
  const { ctx, project } = input;
  if (ctx.flags.json || !process.stdout.isTTY || !process.stdin.isTTY) {
    return list(input);
  }
  const state = loadState(project.name);
  const rows = Object.values(state.workspaces).sort((a, b) => (a.lastUsedAt < b.lastUsedAt ? 1 : -1));
  if (rows.length === 0) return list(input); // reuse the "no workspaces" line

  rows.forEach((ws, i) => {
    const label = ws.kind === "path" ? "(adopted)" : (ws.branch ?? "—");
    process.stderr.write(`  ${i + 1}) ${ws.slug}  ${label}\n`);
  });
  const answer = prompt(`select a workspace [1-${rows.length}] (enter to cancel):`);
  if (answer === null || answer.trim() === "") {
    ctx.log.step("cancelled");
    return ExitCode.SUCCESS;
  }
  const n = Number(answer.trim());
  if (!Number.isInteger(n) || n < 1 || n > rows.length) {
    throw usage(`invalid selection '${answer.trim()}'`, `enter a number between 1 and ${rows.length}`);
  }
  const ws = rows[n - 1]!;
  if (!existsSync(ws.path)) {
    throw resolveError(
      `workspace '${ws.slug}' path is missing`,
      "re-checkout the ref, or sweep it with `clean --prune-state`",
    );
  }
  process.stdout.write(ws.path + "\n");
  return ExitCode.SUCCESS;
}

/** Drop the transient diskBytes field when `--du` wasn't requested. */
function stripDisk(rows: Row[]): Omit<Row, "diskBytes">[] {
  return rows.map(({ diskBytes: _drop, ...rest }) => rest);
}

export async function info(input: WorkspaceInput): Promise<number> {
  const { ctx, project, ref } = input;
  const flags = parseFlags(input.args, { bools: ["--du"] });
  const slug = slugFor(ref);
  const du = flags.bool("--du");
  const rows = await computeRows(project.name, du || ctx.flags.json);
  const row = rows.find((r) => r.slug === slug);
  if (!row) {
    ctx.log.warn(`no workspace '${slug}' for '${project.name}'`);
    return ExitCode.RESOLVE;
  }
  if (ctx.flags.json) {
    process.stdout.write(JSON.stringify(du ? row : stripDisk([row])[0]) + "\n");
    return ExitCode.SUCCESS;
  }
  const fresh = await refreshPrMeta(ctx, project, [row]);
  const lines: [string, string][] = [
    ["slug", row.slug],
    ["kind", row.kind],
    ["ref", row.ref],
    ["branch", row.branch ?? "—"],
    ["path", row.path],
    ["ports", row.ports.join(",") || "—"],
    ["status", status(row, fresh)],
    ["created", row.createdAt],
    ["last used", row.lastUsedAt],
  ];
  if (row.pr) lines.push(["pr", `${row.pr.state} — ${row.pr.title}`], ["pr url", row.pr.url]);
  if (du && row.diskBytes != null) lines.push(["disk", humanBytes(row.diskBytes)]);
  for (const [k, v] of lines) process.stdout.write(`${k}: ${v}\n`);
  return ExitCode.SUCCESS;
}

function humanBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}
