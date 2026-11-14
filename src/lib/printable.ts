// Escaping for text a terminal would act on instead of print (§5.7). Shared by
// the trust gate, which shows a repo file, and the config loaders, whose issues
// can quote one before anything is approved.

// Characters a terminal would act on instead of print: C0 and C1 controls, DEL,
// and the bidi controls that reorder text. A repo file can carry them through
// TOML escapes (`\u001b`, `\r`) or raw (C1, bidi), so they could repaint or
// reorder the very lines the user approves from.
const BIDI = "\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069";
const UNSAFE_IN_LINE = new RegExp(`[\u0000-\u001f\u007f-\u009f${BIDI}]`, "g");
// In a block, tab, newline and a CR that ends a CRLF line stay as they are.
const UNSAFE_IN_BLOCK = new RegExp(`[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f${BIDI}]|\r(?!\n)`, "g");
const NAMED: Record<string, string> = { "\t": "\\t", "\n": "\\n", "\r": "\\r" };

function escapeChar(c: string): string {
  return NAMED[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

/** One value on one line: every control character escaped, newlines included. */
export function printableLine(text: string): string {
  return text.replace(UNSAFE_IN_LINE, escapeChar);
}

/** A file or a diff: control characters escaped, line breaks and tabs kept. */
export function printableBlock(text: string): string {
  return text.replace(UNSAFE_IN_BLOCK, escapeChar);
}

/** Several lines, each escaped as `printableLine`, still on separate lines. */
export function printableLines(text: string): string {
  return text.split("\n").map(printableLine).join("\n");
}
