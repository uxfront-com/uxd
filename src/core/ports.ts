// Deterministic-first port allocation within a project window (§8.5).

import { createServer } from "node:net";
import { fnv1a32 } from "../lib/hash.ts";

export interface AllocateOptions {
  slug: string;
  basePort: number;
  ports: number; // block size (contiguous)
  /** Ports already claimed by other workspaces (from state). */
  reserved: Set<number>;
  /** Injectable probe: true ⇒ port is free to bind. May be sync or async. */
  isFree: (port: number) => boolean | Promise<boolean>;
}

const WINDOW = 100; // ports window is 100 strides wide (§8.5)

/**
 * Allocate a contiguous block of `ports` ports for `slug`. Starts at the
 * deterministic candidate `basePort + (fnv1a32(slug) % 100) * ports`, then scans
 * upward in `ports`-sized strides within the window on conflict (§8.5).
 */
export async function allocatePorts(opts: AllocateOptions): Promise<number[]> {
  const { slug, basePort, ports, reserved, isFree } = opts;
  const stride = ports;
  const windowStart = basePort;
  const windowEnd = basePort + WINDOW * ports; // exclusive
  const startOffset = (fnv1a32(slug) % WINDOW) * stride;

  for (let step = 0; step < WINDOW; step++) {
    const offset = (startOffset + step * stride) % (WINDOW * stride);
    const base = windowStart + offset;
    if (base + ports > windowEnd) continue;
    const block = Array.from({ length: ports }, (_, i) => base + i);
    let ok = true;
    for (const p of block) {
      if (reserved.has(p) || !(await isFree(p))) {
        ok = false;
        break;
      }
    }
    if (ok) return block;
  }

  // Window exhausted — fall back to the deterministic candidate and let the
  // caller warn on re-probe (§8.5). Better a deterministic clash than a throw.
  const base = windowStart + startOffset;
  return Array.from({ length: ports }, (_, i) => base + i);
}

/** Real TCP probe: bind 127.0.0.1:<port>, close immediately (§8.5). */
export function tcpPortFree(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen({ host: "127.0.0.1", port });
  });
}
