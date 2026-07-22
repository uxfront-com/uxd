import { defineConfig } from "vitest/config";

// The integration suite (test/integration/*) drives real `git` subprocesses —
// bare clones and fetches over file:// — several per test. Under vitest's
// parallel file execution these routinely exceed the 5s default, and a timed-out
// in-process run leaks async work that mutates shared env. Give git room.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
