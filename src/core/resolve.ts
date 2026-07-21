// Ref → RefSpec (§6.1), slug() (§6.3), and URL extraction (§4.3).

import { createHash } from "node:crypto";
import { basename } from "node:path";
import { resolvePath } from "../lib/paths.ts";
import { resolveError } from "../lib/errors.ts";

export type RefSpec =
  | { kind: "pr"; number: number }
  | { kind: "branch"; name: string }
  | { kind: "commit"; sha: string } // M2
  | { kind: "path"; path: string } // adopted
  | { kind: "last" }; // resolved before use

const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");

// ── Ref parsing (§6.1) ──────────────────────────────────────────────────────

/** Force interpretation via a disambiguator flag (§4.5). Bypasses table parsing. */
export function refFromDisambiguator(kind: "pr" | "branch" | "path", value: string): RefSpec {
  if (kind === "pr") {
    const m = value.match(/^#?(\d+)$/);
    if (!m) throw resolveError(`--pr expects a number, got '${value}'`);
    return { kind: "pr", number: Number(m[1]) };
  }
  if (kind === "path") return { kind: "path", path: value };
  return { kind: "branch", name: value };
}

/** Parse a user-supplied ref string into a RefSpec (first match wins, §6.1). */
export function parseRef(input: string): RefSpec {
  // 1. last-used shorthand
  if (input === "-") return { kind: "last" };

  // 2. filesystem path
  if (input.startsWith("/") || input.startsWith("./") || input.startsWith("../") || input.startsWith("~")) {
    return { kind: "path", path: input };
  }

  // 3. PR number, optionally #-prefixed
  if (/^#?\d+$/.test(input)) {
    return { kind: "pr", number: Number(input.replace(/^#/, "")) };
  }

  // 4. pr/<n> (case-insensitive)
  const prSlash = input.match(/^pr\/(\d+)$/i);
  if (prSlash) return { kind: "pr", number: Number(prSlash[1]) };

  // 5. full 40-char commit SHA (short SHAs deliberately not auto-detected)
  if (/^[0-9a-f]{40}$/.test(input)) return { kind: "commit", sha: input };

  // 6. otherwise a branch name, validated
  if (isValidBranchName(input)) return { kind: "branch", name: input };

  // 7. no match
  throw resolveError(`could not parse ref '${input}'`, "expected a PR number, branch name, path, or '-'");
}

/**
 * Pure approximation of `git check-ref-format --branch` rules (§6.1 note).
 * Git remains authoritative at fetch time; this gates obvious garbage early
 * and keeps ref parsing unit-testable.
 */
export function isValidBranchName(name: string): boolean {
  if (name === "" || name === "@") return false;
  if (name.startsWith("/") || name.endsWith("/")) return false;
  if (name.startsWith(".") || name.endsWith(".")) return false;
  if (name.endsWith(".lock")) return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{")) return false;
  // Disallowed characters: control chars, space, and ~ ^ : ? * [ \
  if (/[\x00-\x20\x7f ~^:?*[\\]/.test(name)) return false;
  // No path component may begin with a dot or end with .lock.
  for (const part of name.split("/")) {
    if (part === "" || part.startsWith(".") || part.endsWith(".lock")) return false;
  }
  return true;
}

// ── Slugs (§6.3) ────────────────────────────────────────────────────────────

/** Deterministic slug for a RefSpec (§6.3). Collision-append is handled by the workspace layer. */
export function slug(spec: RefSpec): string {
  switch (spec.kind) {
    case "pr":
      return `pr-${spec.number}`;
    case "commit":
      return `sha-${spec.sha.slice(0, 10)}`;
    case "branch":
      return branchSlug(spec.name);
    case "path": {
      const abs = resolvePath(spec.path);
      return `adopted-${sanitize(basename(abs))}-${sha256hex(abs).slice(0, 7)}`;
    }
    case "last":
      throw resolveError("cannot slug an unresolved 'last' ref");
  }
}

function sanitize(name: string): string {
  return name
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .toLowerCase();
}

function branchSlug(name: string): string {
  const s = sanitize(name);
  if (s.length <= 60) return s;
  return `${s.slice(0, 52)}-${sha256hex(name).slice(0, 7)}`;
}

/** Append the hash suffix unconditionally, for collision resolution (§6.3). */
export function collisionSlug(name: string): string {
  const base = branchSlug(name).slice(0, 52);
  return `${base}-${sha256hex(name).slice(0, 7)}`;
}

// ── URL extraction (§4.3) ─────────────────────────────────────────────────

export interface RepoCoords {
  host: string;
  owner: string;
  repo: string;
}

/** Normalize a repo clone URL (ssh or https) to comparable host/owner/repo (§4.3). */
export function normalizeRepoUrl(url: string): RepoCoords | null {
  let host: string;
  let path: string;

  const ssh = url.match(/^git@([^:]+):(.+)$/);
  if (ssh) {
    host = ssh[1]!;
    path = ssh[2]!;
  } else {
    const https = url.match(/^https?:\/\/([^/]+)\/(.+)$/);
    if (!https) return null;
    host = https[1]!;
    path = https[2]!;
  }

  const segs = path.replace(/\.git$/, "").split("/").filter(Boolean);
  if (segs.length < 2) return null;
  return {
    host: host.toLowerCase(),
    owner: segs[0]!.toLowerCase(),
    repo: segs[1]!.toLowerCase(),
  };
}

export interface UrlInput {
  coords: RepoCoords;
  /** Ref encoded in the URL path (/pull/<n> → pr, /tree/<branch> → branch), if any. */
  ref?: RefSpec;
}

/** Parse a p0 URL form into repo coordinates + an optional embedded ref (§4.3). */
export function parseUrlInput(url: string): UrlInput | null {
  const coords = normalizeRepoUrl(url);
  if (!coords) return null;

  // Only https URLs carry /pull/ or /tree/ segments.
  const https = url.match(/^https?:\/\/[^/]+\/(.+)$/);
  if (!https) return { coords };

  const segs = https[1]!.replace(/\.git$/, "").split("/").filter(Boolean);
  // segs[0]=owner, segs[1]=repo, then optionally pull/<n> or tree/<branch...>
  if (segs.length >= 4 && segs[2] === "pull" && /^\d+$/.test(segs[3]!)) {
    return { coords, ref: { kind: "pr", number: Number(segs[3]) } };
  }
  if (segs.length >= 4 && segs[2] === "tree") {
    const branch = segs.slice(3).join("/");
    if (isValidBranchName(branch)) return { coords, ref: { kind: "branch", name: branch } };
  }
  return { coords };
}

export function coordsEqual(a: RepoCoords, b: RepoCoords): boolean {
  return a.host === b.host && a.owner === b.owner && a.repo === b.repo;
}
