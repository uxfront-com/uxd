import { describe, expect, it } from "bun:test";
import { passthrough } from "../../src/lib/proc.ts";
import { isUxdError, type UxdError } from "../../src/lib/errors.ts";

const MISSING = "uxd-no-such-binary-zzz-9f55";

describe("passthrough — missing binary maps to E_SETUP (§14)", () => {
  it("foreground spawn ENOENT → E_SETUP (exit 6), not E_INTERNAL", async () => {
    try {
      await passthrough([MISSING]);
      throw new Error("expected throw");
    } catch (e) {
      expect(isUxdError(e)).toBe(true);
      const err = e as UxdError;
      expect(err.errCode).toBe("E_SETUP");
      expect(err.code).toBe(6);
      expect(err.message).toContain(MISSING);
      expect(err.hint).toBeDefined();
    }
  });

  it("detached spawn ENOENT → E_SETUP as well", async () => {
    try {
      await passthrough([MISSING], { detach: true });
      throw new Error("expected throw");
    } catch (e) {
      expect(isUxdError(e)).toBe(true);
      expect((e as UxdError).errCode).toBe("E_SETUP");
    }
  });
});
