// Synchronous single-line prompt (§9). Node has no global `prompt`, so read one
// line from stdin via a blocking readSync on fd 0. Callers only reach this on an
// interactive TTY. Returns the entered line, or null on EOF with no input —
// matching the web/Bun `prompt` contract the call sites were written against.

import { readSync } from "node:fs";

export function promptLine(message: string): string | null {
  process.stdout.write(`${message} `);

  const buf = Buffer.alloc(256);
  let input = "";
  let readAny = false;

  for (;;) {
    let bytes = 0;
    try {
      bytes = readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") continue; // stdin not ready yet; retry
      if (code === "EOF") break;
      throw e;
    }
    if (bytes === 0) break; // EOF
    readAny = true;
    input += buf.toString("utf8", 0, bytes);
    const nl = input.indexOf("\n");
    if (nl !== -1) {
      input = input.slice(0, nl);
      return input.replace(/\r$/, "");
    }
  }

  if (!readAny) return null; // EOF before any input
  return input.replace(/\r$/, "");
}
