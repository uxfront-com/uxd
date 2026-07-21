import { describe, expect, it } from "bun:test";
import { allocatePorts } from "../../src/core/ports.ts";
import { fnv1a32 } from "../../src/lib/hash.ts";

const freeAll = () => true;

function expectedStart(slug: string, basePort: number, ports: number): number {
  return basePort + (fnv1a32(slug) % 100) * ports;
}

describe("allocatePorts — §8.5 deterministic-first", () => {
  it("returns a contiguous block of the requested size", () => {
    const block = allocatePorts({ slug: "ai-fix", basePort: 5000, ports: 3, reserved: new Set(), isFree: freeAll });
    expect(block.length).toBe(3);
    expect(block).toEqual([block[0]!, block[0]! + 1, block[0]! + 2]);
  });

  it("is deterministic — same slug ⇒ same block", () => {
    const a = allocatePorts({ slug: "ai-fix", basePort: 5000, ports: 2, reserved: new Set(), isFree: freeAll });
    const b = allocatePorts({ slug: "ai-fix", basePort: 5000, ports: 2, reserved: new Set(), isFree: freeAll });
    expect(a).toEqual(b);
  });

  it("starts at basePort + (fnv1a32(slug) % 100) * ports", () => {
    const block = allocatePorts({ slug: "pr-19234", basePort: 4000, ports: 2, reserved: new Set(), isFree: freeAll });
    expect(block[0]).toBe(expectedStart("pr-19234", 4000, 2));
  });

  it("scans upward in stride-sized steps on reserved conflict", () => {
    const start = expectedStart("s", 5000, 2);
    const reserved = new Set([start, start + 1]); // block the deterministic candidate
    const block = allocatePorts({ slug: "s", basePort: 5000, ports: 2, reserved, isFree: freeAll });
    expect(block[0]).toBe(start + 2); // next stride
  });

  it("skips a block when isFree rejects any port in it", () => {
    const start = expectedStart("s", 5000, 2);
    const busy = new Set([start + 1]); // one port in first block busy
    const block = allocatePorts({
      slug: "s",
      basePort: 5000,
      ports: 2,
      reserved: new Set(),
      isFree: (p) => !busy.has(p),
    });
    expect(block[0]).toBe(start + 2);
  });

  it("stays within the 100-stride window (wraps offset)", () => {
    const block = allocatePorts({ slug: "wrap", basePort: 6000, ports: 5, reserved: new Set(), isFree: freeAll });
    expect(block[0]).toBeGreaterThanOrEqual(6000);
    expect(block[block.length - 1]!).toBeLessThan(6000 + 100 * 5);
  });

  it("falls back to deterministic candidate when window exhausted", () => {
    // Everything reserved ⇒ no free block ⇒ returns the deterministic start anyway.
    const start = expectedStart("full", 5000, 1);
    const reserved = new Set(Array.from({ length: 100 }, (_, i) => 5000 + i));
    const block = allocatePorts({ slug: "full", basePort: 5000, ports: 1, reserved, isFree: freeAll });
    expect(block[0]).toBe(start);
  });
});
