// Path helpers: ~ expansion (leading only, no env interpolation) and XDG dirs.

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Expand a leading `~` / `~/` to the user's home. No env-var interpolation (§5.4). */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Expand `~` then make absolute against `base` (default: cwd). */
export function resolvePath(p: string, base = process.cwd()): string {
  const expanded = expandTilde(p);
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

function xdgDir(envVar: string, fallbackSub: string): string {
  const fromEnv = process.env[envVar];
  if (fromEnv && fromEnv.trim() !== "") return expandTilde(fromEnv);
  return join(homedir(), fallbackSub);
}

/** `${XDG_CONFIG_HOME:-~/.config}/uxd` (§5.1). */
export function defaultConfigDir(): string {
  return join(xdgConfigHome(), "uxd");
}

export function xdgConfigHome(): string {
  return xdgDir("XDG_CONFIG_HOME", ".config");
}

/** `${XDG_STATE_HOME:-~/.local/state}/uxd` (§7.6, §8.2). */
export function stateDir(): string {
  return join(xdgStateHome(), "uxd");
}

export function xdgStateHome(): string {
  const fromEnv = process.env.XDG_STATE_HOME;
  if (fromEnv && fromEnv.trim() !== "") return expandTilde(fromEnv);
  return join(homedir(), ".local", "state");
}
