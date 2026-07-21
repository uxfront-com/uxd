// Shell quoting for --dry-run output and safe `bash -c '<run> "$@"'` passthrough.

/** POSIX-quote a single argument so it round-trips through a shell verbatim. */
export function shellQuote(arg: string): string {
  if (arg === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Join an argv array into a copy-pasteable, shell-quoted command line. */
export function shellJoin(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}
