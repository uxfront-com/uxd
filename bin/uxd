#!/usr/bin/env bun
import { main } from "../src/main.ts";

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    // main() should never reject; this is a last-resort guard.
    console.error(`error(E_INTERNAL): ${err?.message ?? String(err)}`);
    process.exit(1);
  },
);
