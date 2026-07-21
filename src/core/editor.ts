// Editor presets + custom templates (§10).

import { interpolate } from "../lib/template.ts";
import { shellQuote } from "../lib/shell.ts";
import type { TemplateVars } from "../lib/template.ts";

export interface EditorLaunch {
  /** argv to spawn. When viaBash, argv is ["bash","-c",script]. */
  argv: string[];
  wait: boolean;
  cwd?: string;
  viaBash: boolean;
}

interface Preset {
  build(path: string): string[];
  wait: boolean;
  needsShellCwd?: boolean;
}

const PRESETS: Record<string, Preset> = {
  zed: { build: (p) => ["zed", p], wait: false },
  code: { build: (p) => ["code", "--new-window", p], wait: false },
  cursor: { build: (p) => ["cursor", "--new-window", p], wait: false },
  windsurf: { build: (p) => ["windsurf", p], wait: false },
  idea: { build: (p) => ["idea", p], wait: false },
  webstorm: { build: (p) => ["webstorm", p], wait: false },
  phpstorm: { build: (p) => ["phpstorm", p], wait: false },
  goland: { build: (p) => ["goland", p], wait: false },
  vim: { build: (p) => ["vim", p], wait: true },
  nvim: { build: (p) => ["nvim", p], wait: true },
  helix: { build: (p) => ["helix", p], wait: true },
  hx: { build: (p) => ["hx", p], wait: true },
  terminal: { build: () => [process.env.SHELL || "bash"], wait: true, needsShellCwd: true },
};

/** The editor binary a preset would invoke (for doctor PATH check, §9.11). */
export function presetBinary(editor: string): string | null {
  const preset = PRESETS[editor];
  if (!preset) return null;
  if (editor === "terminal") return process.env.SHELL || "bash";
  return preset.build("/x")[0]!;
}

/** Resolve an `editor` config (preset name or custom template) into a launch plan (§10). */
export function resolveEditor(editor: string, path: string, vars: TemplateVars): EditorLaunch {
  const preset = PRESETS[editor];
  if (preset) {
    return {
      argv: preset.build(path),
      wait: preset.wait,
      cwd: preset.needsShellCwd ? path : undefined,
      viaBash: false,
    };
  }

  // Custom template: must contain {path}; runs via bash -c with {path} shell-escaped.
  let wait = false;
  let template = editor;
  if (template.endsWith(":wait")) {
    wait = true;
    template = template.slice(0, -":wait".length).trimEnd();
  }
  const shellVars: TemplateVars = { ...vars, path: shellQuote(path) };
  const script = interpolate(template, shellVars, "editor");
  return { argv: ["bash", "-c", script], wait, viaBash: true };
}

export function isPreset(editor: string): boolean {
  return editor in PRESETS;
}
