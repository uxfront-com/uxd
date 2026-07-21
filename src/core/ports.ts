// Deterministic-first port allocation within a project window (§8.5).

import { fnv1a32 } from "../lib/hash.ts";

export interface AllocateOptions {
  slug: string;
  basePort: number;
  ports: number; // block size (contiguous)
  /** Ports already claimed by other workspaces (from state). */
  reserved: Set<number>;
  /** Injectable probe: true ⇒ port is free to bind. */
  isFree: (port: number) => boolean;
}

const WINDOW = 100; // ports window is 100 strides wide (§8.5)

/**
 * Allocate a contiguous block of `ports` ports for `slug`. Starts at the
 * deterministic candidate `basePort + (fnv1a32(slug) % 100) * ports`, then scans
 * upward in `ports`-sized strides within the window on conflict (§8.5).
 */
export function allocatePorts(opts: AllocateOptions): number[] {
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
    if (block.every((p) => !reserved.has(p) && isFree(p))) {
      return block;
    }
  }

  // Window exhausted — fall back to the deterministic candidate and let the
  // caller warn on re-probe (§8.5). Better a deterministic clash than a throw.
  const base = windowStart + startOffset;
  return Array.from({ length: ports }, (_, i) => base + i);
}

/** Real TCP probe: bind 127.0.0.1:<port>, close immediately (§8.5). */
export function tcpPortFree(port: number): boolean {
  try {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: { data() {}, open() {}, close() {} },
    });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}
