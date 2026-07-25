import { defineConfig } from "vitest/config";

// The integration suite (test/integration/*) drives real `git` subprocesses —
// bare clones and fetches over file:// — several per test. Under vitest's
// parallel file execution these routinely exceed the 5s default, and a timed-out
// in-process run leaks async work that mutates shared env. Give git room.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The root suite covers the `uxd` CLI only. Workspace apps under `apps/*`
    // (e.g. the Nuxt `apps/docs` site) own their own test runners and configs,
    // so they are excluded here — otherwise the root `vitest run` would try to
    // collect their tests without a prepared framework environment.
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "dist/**", "apps/**"],
  },
});
