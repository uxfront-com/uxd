// Resolve an executable on PATH, cross-platform (§14). Mirrors `Bun.which`:
// returns the absolute path of the first match, or null when not found.

import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export function which(bin: string): string | null {
  const rawPath = process.env.PATH ?? "";
  if (!rawPath) return null;

  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];

  for (const dir of rawPath.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        // unreadable entry; keep scanning
      }
    }
  }
  return null;
}
