// FNV-1a 32-bit — used for deterministic port/base_port derivation (§5.4, §8.5).

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a 32-bit hash of a UTF-8 string, returned as an unsigned 32-bit integer. */
export function fnv1a32(input: string): number {
  let hash = FNV_OFFSET_BASIS;
  const bytes = new TextEncoder().encode(input);
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    // Multiply mod 2^32 without overflowing Number precision.
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}
