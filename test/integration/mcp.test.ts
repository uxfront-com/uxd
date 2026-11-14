// `testlane mcp` (ADR-003): the built CLI, spawned as an MCP server over stdio.
// Each test name starts with its acceptance-criterion ID, so `-t "C8"` picks it.
// dist/ is built once in test/global-setup.ts. Every server and every process
// a test started is killed in afterEach.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeEnv, makeFixtureOrigin, type Harness, type ProjectSpec } from "../fixtures.ts";
import { builtCli, McpClient } from "../mcp-client.ts";
import { fetchBranch } from "../../src/git/repo.ts";
import { Logger } from "../../src/lib/log.ts";

// A server on $TESTLANE_PORT that logs one line once it listens.
const SERVER =
  `node -e "require('http').createServer((q,s)=>s.end('ok'))` +
  `.listen(process.env.TESTLANE_PORT,'127.0.0.1',()=>console.log('listening on '+process.env.TESTLANE_PORT))"`;

const TOOL_NAMES = [
  "projects",
  "doctor",
  "config_validate",
  "list",
  "ps",
  "info",
  "diff",
  "logs",
  "checkout",
  "start",
  "stop",
  "rm",
];

let tmp: string;
let origin: ReturnType<typeof makeFixtureOrigin>;
let clients: McpClient[];
/** Projects whose `start` entries and `bg.pid` files afterEach kills. */
let envs: Array<{ env: Harness; projects: string[] }>;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "testlane-mcp-")));
  origin = makeFixtureOrigin(tmp);
  origin.commit("main", { "README.md": "# fixture\n" });
  origin.commit("feature-x", { "feat.txt": "hello\n" });
  clients = [];
  envs = [];
});

afterEach(async () => {
  for (const c of clients) c.kill();
  await Promise.all(clients.map((c) => c.exited));
  const pids: number[] = [];
  for (const { env, projects } of envs) {
    for (const project of projects) {
      const trees = env.worktreesPath(project);
      const data = join(trees, ".data");
      if (existsSync(data)) {
        for (const slug of readdirSync(data)) {
          const file = join(data, slug, "process.json");
          if (existsSync(file)) pids.push(Number(JSON.parse(readFileSync(file, "utf8")).pid));
        }
      }
      if (existsSync(trees)) {
        for (const slug of readdirSync(trees)) {
          const file = join(trees, slug, "bg.pid");
          if (existsSync(file)) pids.push(Number(readFileSync(file, "utf8").trim()));
        }
      }
    }
  }
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 1) continue;
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  rmSync(tmp, { recursive: true, force: true });
});

/** Config for `projects`, with a `web` command in each unless it says otherwise. */
function makeMcpEnv(projects: Record<string, string>): Harness {
  const specs: Record<string, ProjectSpec> = {};
  for (const [name, toml] of Object.entries(projects)) {
    specs[name] = {
      repo: origin.url,
      defaultBranch: "main",
      extraToml: [toml, `[commands.web]`, `run = ${JSON.stringify(SERVER)}`].join("\n"),
    };
  }
  const env = makeEnv(tmp, specs);
  envs.push({ env, projects: Object.keys(projects) });
  return env;
}

function serverEnv(env: Harness): Record<string, string> {
  return { TESTLANE_CONFIG_DIR: env.configDir, XDG_STATE_HOME: env.stateHome };
}

function connect(env: Harness, preArgs: string[] = []): McpClient {
  const c = new McpClient(serverEnv(env), preArgs);
  clients.push(c);
  return c;
}

/** The built CLI's `--json` answer, spawned with the server's environment. */
function cliJson(env: Harness, argv: string[]): { code: number; value: any } {
  const r = spawnSync(process.execPath, [builtCli, ...argv, "--json"], {
    encoding: "utf8",
    env: { ...(process.env as Record<string, string>), NO_COLOR: "1", TESTLANE_DEBUG: "0", ...serverEnv(env) },
  });
  return { code: r.status ?? -1, value: JSON.parse(r.stdout) };
}

/** Same keys everywhere, and equal values outside `changing`. */
function expectSameShape(tool: unknown, cli: unknown, changing: string[] = [], path = "$"): void {
  if (Array.isArray(cli)) {
    expect(Array.isArray(tool), path).toBe(true);
    expect((tool as unknown[]).length, path).toBe(cli.length);
    cli.forEach((v, i) => expectSameShape((tool as unknown[])[i], v, changing, `${path}[${i}]`));
    return;
  }
  if (cli !== null && typeof cli === "object") {
    expect(tool !== null && typeof tool === "object", path).toBe(true);
    expect(Object.keys(tool as object).sort(), path).toEqual(Object.keys(cli).sort());
    for (const [k, v] of Object.entries(cli)) {
      if (changing.includes(k)) continue;
      expectSameShape((tool as Record<string, unknown>)[k], v, changing, `${path}.${k}`);
    }
    return;
  }
  expect(tool, path).toEqual(cli);
}

function httpGet(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path: "/" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every stdout line is one JSON-RPC 2.0 message. */
function expectOnlyProtocol(c: McpClient): void {
  expect(c.stdoutLines.length).toBeGreaterThan(0);
  for (const line of c.stdoutLines) {
    let msg: { jsonrpc?: string } | undefined;
    try {
      msg = JSON.parse(line);
    } catch {
      msg = undefined;
    }
    expect(msg?.jsonrpc, `stdout line: ${line}`).toBe("2.0");
  }
}

// ── C3: protocol ────────────────────────────────────────────────────────────

describe("protocol", () => {
  it("C3 — initialize echoes a supported version, else answers 2025-11-25", async () => {
    const env = makeMcpEnv({ app: "" });
    const c = connect(env);
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    for (const v of ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "1999-01-01"]) {
      const r = await c.request("initialize", { protocolVersion: v, capabilities: {}, clientInfo: { name: "t", version: "0" } });
      expect(r.msg.result).toEqual({
        protocolVersion: v === "1999-01-01" ? "2025-11-25" : v,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "testlane", version: pkg.version },
      });
    }
    expect(await c.close()).toBe(0);
  });

  it("C3 — ping, an unknown method, an unknown tool, a line that isn't JSON, and a batch", async () => {
    const env = makeMcpEnv({ app: "" });
    const c = connect(env);
    await c.initialize();
    expect((await c.request("ping")).msg.result).toEqual({});
    expect((await c.request("resources/list")).msg.error?.code).toBe(-32601);
    expect((await c.request("tools/call", { name: "exec", arguments: {} })).msg.error?.code).toBe(-32602);

    const parseError = c.expect(null);
    c.sendLine("{not json");
    expect((await parseError).msg.error?.code).toBe(-32700);
    const batch = c.expect(null);
    c.sendLine(JSON.stringify([{ jsonrpc: "2.0", id: 9, method: "ping" }]));
    expect((await batch).msg.error?.code).toBe(-32600);

    // The server is still there after each of them.
    expect((await c.request("ping")).msg.result).toEqual({});
    expectOnlyProtocol(c);
    expect(await c.close()).toBe(0);
  });
});

// ── C4: tool set ────────────────────────────────────────────────────────────

describe("tools/list", () => {
  it("C4 — names exactly the 12 tools, with closed object schemas and their annotations", async () => {
    const env = makeMcpEnv({ app: "" });
    const c = connect(env);
    await c.initialize();
    const tools = (await c.request("tools/list")).msg.result!.tools as Array<{
      name: string;
      description: string;
      inputSchema: { type: string; additionalProperties: boolean; properties: Record<string, unknown> };
      annotations: { readOnlyHint?: boolean; destructiveHint?: boolean };
    }>;
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    const readOnly = ["projects", "doctor", "config_validate", "list", "ps", "info", "diff", "logs"];
    for (const t of tools) {
      expect(t.description.length, t.name).toBeGreaterThan(0);
      expect(t.inputSchema.type, t.name).toBe("object");
      expect(t.inputSchema.additionalProperties, t.name).toBe(false);
      for (const banned of ["argv", "args", "passthrough", "force", "exec", "yes"]) {
        expect(Object.keys(t.inputSchema.properties), t.name).not.toContain(banned);
      }
      if (readOnly.includes(t.name)) expect(t.annotations, t.name).toEqual({ readOnlyHint: true });
      else if (t.name === "rm") expect(t.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
      else expect(t.annotations, t.name).toEqual({ readOnlyHint: false, destructiveHint: false });
    }
    // Only the two long tools take a timeout.
    const withTimeout = tools.filter((t) => "timeout" in t.inputSchema.properties).map((t) => t.name);
    expect(withTimeout.sort()).toEqual(["checkout", "start"]);
    await c.close();
  });
});

// ── C5: same function, same shape ───────────────────────────────────────────

describe("same shape as the CLI's --json", () => {
  it("C5 — each --json tool returns what the built CLI prints for the same state", async () => {
    const env = makeMcpEnv({ shape: "" });
    const c = connect(env);
    await c.initialize();

    const co = await c.call("checkout", { project: "shape", ref: "feature-x" });
    expect(co.isError, JSON.stringify(co.value)).toBe(false);
    expect(co.value.created).toBe(true);
    expectSameShape(co.value, cliJson(env, ["shape", "feature-x", "checkout"]).value, ["created"]);

    const st = await c.call("start", { project: "shape", ref: "feature-x", command: "web", timeout: 20 });
    expect(st.isError, JSON.stringify(st.value)).toBe(false);
    expect(st.value.reused).toBe(false);
    expectSameShape(st.value, cliJson(env, ["shape", "feature-x", "start", "web"]).value, ["reused"]);

    const pairs: Array<[string, Record<string, unknown>, string[], string[]]> = [
      ["projects", {}, ["projects"], []],
      ["doctor", {}, ["doctor"], []],
      ["config_validate", {}, ["config", "validate"], []],
      ["list", { project: "shape" }, ["shape", "list"], ["lastUsedAt", "diskBytes"]],
      ["ps", { project: "shape" }, ["shape", "ps"], []],
      ["info", { project: "shape", ref: "feature-x" }, ["shape", "feature-x", "info"], ["lastUsedAt", "diskBytes"]],
    ];
    for (const [tool, args, argv, changing] of pairs) {
      const t = await c.call(tool, args);
      const cli = cliJson(env, argv);
      expect(t.isError, tool).toBe(cli.code !== 0);
      expectSameShape(t.value, cli.value, changing);
    }
    await c.call("stop", { project: "shape", ref: "feature-x" });
    await c.close();
  });
});

// ── C6: text verbs ──────────────────────────────────────────────────────────

describe("stop, logs, diff and rm", () => {
  it("C6 — logs returns the last lines while the process runs", async () => {
    const env = makeMcpEnv({ text: "" });
    const c = connect(env);
    await c.initialize();
    const st = await c.call("start", { project: "text", ref: "feature-x", command: "web", timeout: 20 });
    expect(st.isError, JSON.stringify(st.value)).toBe(false);
    // Three more lines after "listening on".
    for (const n of [1, 2, 3]) writeFileSync(st.value.log, `line ${n}\n`, { flag: "a" });

    const logs = await c.call("logs", { project: "text", ref: "feature-x", lines: 3 });
    expect(logs.isError).toBe(false);
    expect(logs.value).toEqual({ exitCode: 0, stdout: "line 1\nline 2\nline 3\n", stderr: "" });
    const all = await c.call("logs", { project: "text", ref: "feature-x" });
    expect(all.value.stdout).toContain(`listening on ${st.value.port}`);
    // It returned while the process still runs.
    expect(alive(st.value.pid)).toBe(true);

    const stop = await c.call("stop", { project: "text", ref: "feature-x" });
    expect(stop.isError).toBe(false);
    expect(stop.value.exitCode).toBe(0);
    expect(stop.value.stderr).toMatch(/web (stopped|killed after the grace period) \(pid \d+\)/);
    expect((await c.call("logs", { project: "text", ref: "main", lines: 0 })).isError).toBe(true);
    await c.close();
  });

  it("C6 — rm keeps a workspace with uncommitted changes, and says so", async () => {
    const env = makeMcpEnv({ text: "" });
    const c = connect(env);
    await c.initialize();
    const co = await c.call("checkout", { project: "text", ref: "feature-x" });
    writeFileSync(join(co.value.path, "untracked.txt"), "work in progress\n");

    const kept = await c.call("rm", { project: "text", ref: "feature-x" });
    expect(kept.isError).toBe(true);
    expect(kept.value).toMatchObject({ exitCode: 0, stdout: "", removed: false });
    expect(kept.value.stderr).toContain("skipping feature-x: worktree is dirty");
    expect(existsSync(co.value.path)).toBe(true);

    rmSync(join(co.value.path, "untracked.txt"));
    const gone = await c.call("rm", { project: "text", ref: "feature-x" });
    expect(gone.isError).toBe(false);
    expect(gone.value).toMatchObject({ exitCode: 0, stdout: "feature-x\n", removed: true });
    expect(existsSync(co.value.path)).toBe(false);
    await c.close();
  });

  it("C6 — diff over 1 MiB returns its first 1 MiB and truncated: true", async () => {
    const line = "0123456789".repeat(7) + "\n";
    origin.commit("big", { "big.txt": line.repeat(Math.ceil((2 * 1024 * 1024) / line.length)) });
    const env = makeMcpEnv({ text: "" });
    const c = connect(env);
    await c.initialize();
    await c.call("checkout", { project: "text", ref: "big" });

    const d = await c.call("diff", { project: "text", ref: "big" });
    expect(d.isError, d.value.stderr).toBe(false);
    expect(d.value.truncated).toBe(true);
    expect(Buffer.byteLength(d.value.stdout)).toBeLessThanOrEqual(1024 * 1024);
    expect(Buffer.byteLength(d.value.stdout)).toBeGreaterThan(1024 * 1024 - 200);
    expect(d.value.stdout).toMatch(/^diff --git a\/big.txt b\/big.txt\n/);
    expect(d.value.stdout.endsWith("\n")).toBe(true);

    await c.call("checkout", { project: "text", ref: "feature-x" });
    const small = await c.call("diff", { project: "text", ref: "feature-x", stat: true });
    expect(small.value.truncated).toBeUndefined();
    expect(small.value.stdout).toContain("feat.txt");
    await c.close();
  });
});

// ── C7: errors ──────────────────────────────────────────────────────────────

describe("errors", () => {
  it("C7 — a thrown error and bad arguments come back as isError results", async () => {
    const env = makeMcpEnv({ app: "" });
    const c = connect(env);
    await c.initialize();
    const unknown = await c.call("list", { project: "nope" });
    expect(unknown.isError).toBe(true);
    expect(unknown.value.error).toMatchObject({ errCode: "E_CONFIG", exitCode: 3, message: "unknown project 'nope'" });
    expect(typeof unknown.value.stderr).toBe("string");

    for (const args of [
      { project: "app", ref: "main", command: "web", timeout: -1 },
      { project: "app", ref: "main", command: "--port" },
      { project: "app", ref: "main", command: "web", extra: true },
      { project: "app", ref: "main" },
    ]) {
      const bad = await c.call("start", args);
      expect(bad.isError, JSON.stringify(args)).toBe(true);
      expect(bad.value.error.errCode).toBe("E_USAGE");
      expect(bad.value.error.message).toContain("invalid arguments for 'start'");
    }
    // Nothing was started or checked out.
    expect((await c.call("list", { project: "app" })).value).toEqual([]);
    await c.close();
  });

  it("C7 — a ref that starts with '-' is rejected, so it can't reach git as an option", async () => {
    const env = makeMcpEnv({ app: "" });
    const c = connect(env);
    await c.initialize();
    const cases = [
      { tool: "checkout", args: { ref: `--upload-pack=touch ${join(tmp, "PWNED1")}; git-upload-pack`, kind: "branch" }, file: "PWNED1" },
      { tool: "checkout", args: { ref: `--upload-pack=touch\${IFS}${join(tmp, "PWNED2")};git-upload-pack` }, file: "PWNED2" },
      { tool: "start", args: { ref: `--upload-pack=touch ${join(tmp, "PWNED3")}; git-upload-pack`, kind: "branch", command: "web" }, file: "PWNED3" },
      { tool: "start", args: { ref: `--upload-pack=touch\${IFS}${join(tmp, "PWNED4")};git-upload-pack`, command: "web" }, file: "PWNED4" },
    ];
    for (const { tool, args, file } of cases) {
      const r = await c.call(tool, { project: "app", timeout: 20, ...args });
      expect(r.isError, `${tool} ${file}`).toBe(true);
      expect(r.value.error.errCode, `${tool} ${file}`).toBe("E_RESOLVE");
      expect(existsSync(join(tmp, file)), `${tool} ${file}`).toBe(false);
    }
    await c.close();
  });

  it("C7 — git fetch ends its options before the branch name, so even an unchecked one runs nothing", async () => {
    const repo = join(tmp, "bare.git");
    spawnSync("git", ["clone", "-q", "--bare", origin.path, repo]);
    const log = new Logger({ quiet: true, verbose: false, color: false });
    const pwned = join(tmp, "PWNED-FETCH");
    await expect(
      fetchBranch({ repoPath: repo, dryRun: false, log }, `--upload-pack=touch ${pwned}; git-upload-pack`),
    ).rejects.toThrow();
    expect(existsSync(pwned)).toBe(false);
    // A real branch still fetches.
    await fetchBranch({ repoPath: repo, dryRun: false, log }, "feature-x");
  });

  it("C7 — with a missing config dir the server starts, doctor works and projects fails with E_CONFIG", async () => {
    const env = makeMcpEnv({ app: "" });
    const c = connect(env, ["--config-dir", join(tmp, "missing")]);
    await c.initialize();
    const doctor = await c.call("doctor");
    expect(Array.isArray(doctor.value.checks)).toBe(true);
    expect(doctor.value.checks.find((x: { name: string }) => x.name === "config dir").status).toBe("fail");
    const projects = await c.call("projects");
    expect(projects.isError).toBe(true);
    expect(projects.value.error.errCode).toBe("E_CONFIG");
    expect(projects.value.error.message).toContain("config directory does not exist");
    expect(await c.close()).toBe(0);
  });
});

// ── C8: stdout carries only protocol messages ───────────────────────────────

describe("stdout", () => {
  it("C8 — setup, pre_run and the command print to stdout, and none of it reaches the server's stdout", async () => {
    const both = "echo MARKER-OUT; echo MARKER-ERR >&2";
    const env = makeMcpEnv({
      loud: [`[setup]`, `run = ${JSON.stringify(both)}`, `[hooks]`, `pre_run = ${JSON.stringify(both)}`, `post_checkout = ${JSON.stringify(both)}`].join("\n"),
      reader: [`[setup]`, `run = "cat > /dev/null; echo read-done"`].join("\n"),
    });
    const toml = readFileSync(join(env.configDir, "loud.toml"), "utf8");
    writeFileSync(join(env.configDir, "loud.toml"), toml.replace(`run = ${JSON.stringify(SERVER)}`, `run = ${JSON.stringify(`${both}; ${SERVER}`)}`));
    const c = connect(env);
    await c.initialize();

    const co = await c.call("checkout", { project: "loud", ref: "feature-x", setup: true });
    expect(co.isError, JSON.stringify(co.value)).toBe(false);
    const st = await c.call("start", { project: "loud", ref: "feature-x", command: "web", timeout: 20, reseed: true });
    expect(st.isError, JSON.stringify(st.value)).toBe(false);
    await c.call("logs", { project: "loud", ref: "feature-x" });
    await c.call("stop", { project: "loud", ref: "feature-x" });

    // A setup that reads stdin gets end-of-file at once, and the server still answers.
    const read = await c.call("checkout", { project: "reader", ref: "feature-x", setup: true, timeout: 20 });
    expect(read.isError, JSON.stringify(read.value)).toBe(false);
    expect((await c.request("ping")).msg.result).toEqual({});

    expectOnlyProtocol(c);
    const stdout = c.stdoutLines.join("\n");
    // The marker reaches the client only inside JSON strings (the log tool), never as a line of its own.
    expect(c.stdoutLines.some((l) => l.startsWith("MARKER"))).toBe(false);
    expect(stdout).not.toContain("→ running setup");
    expect(c.stderr).toContain("MARKER-OUT");
    expect(c.stderr).toContain("MARKER-ERR");
    expect(c.stderr).toContain("→ running setup");
    expect(c.stderr).toContain("read-done");
    expect(await c.close()).toBe(0);
  });
});

// ── C9: progress ────────────────────────────────────────────────────────────

describe("progress", () => {
  it("C9 — checkout and start with a progress token get progress and heartbeats; calls without one get none", async () => {
    const slow = [`[setup]`, `run = "sleep 6"`].join("\n");
    const env = makeMcpEnv({ p1: slow, p2: slow, p3: slow, p4: slow });
    const c = connect(env);
    await c.initialize();

    // Four projects, so the calls run at once instead of queueing on one project lock.
    const sent = Date.now();
    const [a, b, nc, ns] = await Promise.all([
      c.call("checkout", { project: "p1", ref: "feature-x", setup: true, timeout: 30 }, { progressToken: "tok-a" }),
      c.call("start", { project: "p2", ref: "feature-x", command: "web", timeout: 30 }, { progressToken: 7 }),
      c.call("checkout", { project: "p3", ref: "feature-x", setup: true, timeout: 30 }),
      c.call("start", { project: "p4", ref: "feature-x", command: "web", timeout: 30 }),
    ]);
    for (const r of [a, b, nc, ns]) expect(r.isError, JSON.stringify(r.value)).toBe(false);

    for (const [token, answer] of [["tok-a", a], [7, b]] as const) {
      const p = c.progress(token);
      expect(p.length, String(token)).toBeGreaterThanOrEqual(2);
      const values = p.map((x) => x.msg.params!.progress as number);
      for (let i = 1; i < values.length; i++) expect(values[i]!).toBeGreaterThan(values[i - 1]!);
      expect(p.every((x) => x.at <= answer.at)).toBe(true);
      expect(p.some((x) => x.at - sent >= 5_000)).toBe(true);
      expect(p.some((x) => x.msg.params!.message === "running setup")).toBe(true);
    }
    const tokens = new Set(
      c.received.filter((r) => r.msg.method === "notifications/progress").map((r) => r.msg.params!.progressToken),
    );
    expect([...tokens].sort()).toEqual([7, "tok-a"].sort());
    await c.call("stop", { project: "p2", ref: "feature-x" });
    await c.call("stop", { project: "p4", ref: "feature-x" });
    await c.close();
  }, 30_000);
});

// ── C10: timeout and cancel ─────────────────────────────────────────────────

describe("timeout and cancel", () => {
  const hang = [`[setup]`, `run = "sleep 30 & echo $! > bg.pid; wait"`].join("\n");

  it("C10 — a checkout or start past its timeout stops its setup and answers timedOut", async () => {
    const env = makeMcpEnv({ t1: hang, t2: hang });
    const c = connect(env);
    await c.initialize();
    for (const [tool, project, args] of [
      ["checkout", "t1", { setup: true }],
      ["start", "t2", { command: "web" }],
    ] as const) {
      const sent = Date.now();
      const r = await c.call(tool, { project, ref: "feature-x", timeout: 2, ...args });
      const took = Date.now() - sent;
      expect(r.isError, tool).toBe(true);
      expect(r.value).toMatchObject({ timedOut: true, timeoutSeconds: 2 });
      expect(r.value.stderr).toContain("→ running setup");
      expect(took, tool).toBeGreaterThanOrEqual(2_000);
      expect(took, tool).toBeLessThan(6_000);
      // The setup's background child is already dead, with no wait.
      const pid = Number(readFileSync(join(env.worktreesPath(project), "feature-x", "bg.pid"), "utf8"));
      expect(alive(pid), `${tool} bg pid`).toBe(false);
      const ps = await c.call("ps", { project });
      expect(ps.value.filter((row: { status: string }) => row.status === "running")).toEqual([]);
    }
    // The workspaces' locks are free again: the next call runs.
    const again = await c.call("checkout", { project: "t1", ref: "feature-x" });
    expect(again.isError, JSON.stringify(again.value)).toBe(false);
    await c.close();
  }, 30_000);

  it("C10 — a start waiting on another start's lock times out as timedOut, and a cancel stops the first", async () => {
    const env = makeMcpEnv({ t3: hang });
    const c = connect(env);
    await c.initialize();
    const first = c.request(
      "tools/call",
      { name: "start", arguments: { project: "t3", ref: "feature-x", command: "web", timeout: 60 } },
      "first",
    );
    let firstAnswered = false;
    void first.then(() => (firstAnswered = true));
    // Wait until the first one is in its setup, holding the start lock.
    const bgFile = join(env.worktreesPath("t3"), "feature-x", "bg.pid");
    for (let i = 0; i < 100 && !existsSync(bgFile); i++) await sleep(100);
    expect(existsSync(bgFile)).toBe(true);

    const sent = Date.now();
    const second = await c.call("start", { project: "t3", ref: "feature-x", command: "web", timeout: 2 });
    expect(Date.now() - sent).toBeLessThan(6_000);
    expect(second.isError).toBe(true);
    expect(second.value).toMatchObject({ timedOut: true, timeoutSeconds: 2 });

    const pid = Number(readFileSync(bgFile, "utf8"));
    expect(alive(pid)).toBe(true);
    c.notify("notifications/cancelled", { requestId: "first", reason: "test" });
    for (let i = 0; i < 40 && alive(pid); i++) await sleep(100);
    expect(alive(pid)).toBe(false);
    // A cancelled request gets no response.
    expect((await c.request("ping")).msg.result).toEqual({});
    await sleep(500);
    expect(firstAnswered).toBe(false);
    expect(c.received.some((r) => r.msg.id === "first")).toBe(false);
    const ps = await c.call("ps", { project: "t3" });
    expect(ps.value.filter((row: { status: string }) => row.status === "running")).toEqual([]);
    expect(await c.close()).toBe(0);
  }, 30_000);
});

// ── C11: round trip ─────────────────────────────────────────────────────────

describe("round trip", () => {
  it("C11 — initialize, tools/list, checkout, start, GET, logs, stop, ps and rm", async () => {
    const env = makeMcpEnv({ demo: "" });
    const c = connect(env);
    const init = await c.initialize();
    expect(init.msg.result!.serverInfo).toMatchObject({ name: "testlane" });
    const tools = (await c.request("tools/list")).msg.result!.tools as Array<{ name: string }>;
    expect(tools).toHaveLength(12);

    const co = await c.call("checkout", { project: "demo", ref: "feature-x" });
    expect(co.isError).toBe(false);
    expect(co.value).toMatchObject({ project: "demo", slug: "feature-x", kind: "branch", branch: "feature-x", created: true });
    expect(existsSync(join(co.value.path, "feat.txt"))).toBe(true);

    const st = await c.call("start", { project: "demo", ref: "feature-x", command: "web", timeout: 20 });
    expect(st.isError, JSON.stringify(st.value)).toBe(false);
    expect(st.value).toMatchObject({ project: "demo", slug: "feature-x", command: "web", reused: false });
    expect(st.value.url).toBe(`http://127.0.0.1:${st.value.port}`);
    expect(await httpGet(st.value.port)).toBe("ok");

    const logs = await c.call("logs", { project: "demo", ref: "feature-x" });
    expect(logs.value.stdout).toContain("listening on");

    const stop = await c.call("stop", { project: "demo", ref: "feature-x" });
    expect(stop.isError).toBe(false);
    expect(alive(st.value.pid)).toBe(false);
    const ps = await c.call("ps", { project: "demo" });
    expect(ps.value).toEqual([]);

    const rm = await c.call("rm", { project: "demo", ref: "feature-x" });
    expect(rm.isError).toBe(false);
    expect(rm.value.removed).toBe(true);
    expect(existsSync(co.value.path)).toBe(false);
    expect((await c.call("list", { project: "demo" })).value).toEqual([]);

    expectOnlyProtocol(c);
    expect(await c.close()).toBe(0);
  });
});

// ── A repo's .testlane.toml (§5.7): no tool call can approve it ─────────────

describe("a repo's .testlane.toml", () => {
  const REPO_FILE = [`[hooks]`, `post_checkout = "echo repo > {data_dir}/hook.txt"`, ``].join("\n");

  function repoState(env: Harness): { repoConfig?: { sha256: string; content: string } } | null {
    const file = join(env.stateHome, "testlane", "app.json");
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  }
  const hookFile = (env: Harness, slug: string) => join(env.worktreesPath("app"), ".data", slug, "hook.txt");

  /** The refusal the CLI gives off a terminal, as the tool's error envelope. */
  function expectRefused(r: { isError: boolean; value: any }, message: string): void {
    expect(r.isError, JSON.stringify(r.value)).toBe(true);
    expect(r.value.error).toMatchObject({ errCode: "E_CONFIG", exitCode: 3, message, hint: "testlane config trust app" });
  }

  it("checkout of an untrusted file fails, records no trust, creates nothing and runs no hook", async () => {
    origin.commit("main", { ".testlane.toml": REPO_FILE });
    const env = makeMcpEnv({ app: "" });
    const c = connect(env);
    await c.initialize();

    expectRefused(await c.call("checkout", { project: "app", ref: "feature-x" }), "app:.testlane.toml is not trusted");
    expect(repoState(env)?.repoConfig).toBeUndefined();
    expect(existsSync(join(env.worktreesPath("app"), "feature-x"))).toBe(false);
    expect(existsSync(hookFile(env, "feature-x"))).toBe(false);
    expectOnlyProtocol(c);
    expect(await c.close()).toBe(0);
  });

  it("start of an untrusted file fails, records no trust, creates nothing and runs nothing", async () => {
    origin.commit("main", { ".testlane.toml": REPO_FILE });
    const env = makeMcpEnv({ app: "" });
    const c = connect(env);
    await c.initialize();

    const st = await c.call("start", { project: "app", ref: "feature-x", command: "web", timeout: 20 });
    expectRefused(st, "app:.testlane.toml is not trusted");
    expect(repoState(env)?.repoConfig).toBeUndefined();
    expect(existsSync(join(env.worktreesPath("app"), "feature-x"))).toBe(false);
    expect(existsSync(hookFile(env, "feature-x"))).toBe(false);
    expect((await c.call("ps", { project: "app" })).value).toEqual([]);
    expect(await c.close()).toBe(0);
  });

  it("after `testlane --yes config trust`, checkout succeeds and runs the repo hook", async () => {
    origin.commit("main", { ".testlane.toml": REPO_FILE });
    const env = makeMcpEnv({ app: "" });
    const c = connect(env);
    await c.initialize();
    expectRefused(await c.call("checkout", { project: "app", ref: "feature-x" }), "app:.testlane.toml is not trusted");

    // A person approves it on the CLI; the server needs no restart.
    const trust = await env.run(["--yes", "config", "trust", "app"]);
    expect(trust.code, trust.stderr).toBe(0);
    const approved = repoState(env)!.repoConfig!;
    expect(approved.content).toBe(REPO_FILE);

    const co = await c.call("checkout", { project: "app", ref: "feature-x" });
    expect(co.isError, JSON.stringify(co.value)).toBe(false);
    expect(co.value.created).toBe(true);
    expect(readFileSync(hookFile(env, "feature-x"), "utf8").trim()).toBe("repo");
    expect(repoState(env)!.repoConfig).toEqual(approved);
    expect(await c.close()).toBe(0);
  });

  it("a file changed since it was trusted fails and keeps the approval", async () => {
    origin.commit("main", { ".testlane.toml": REPO_FILE });
    const env = makeMcpEnv({ app: "" });
    expect((await env.run(["--yes", "config", "trust", "app"])).code).toBe(0);
    const approved = repoState(env)!.repoConfig!;
    const c = connect(env);
    await c.initialize();
    expect((await c.call("checkout", { project: "app", ref: "main" })).isError).toBe(false);

    origin.commit("main", { ".testlane.toml": REPO_FILE.replace("echo repo", "echo changed") });
    const again = await c.call("checkout", { project: "app", ref: "main", fetch: true });
    expectRefused(again, "app:.testlane.toml changed since you trusted it");
    expect(repoState(env)!.repoConfig).toEqual(approved);
    expect(await c.close()).toBe(0);
  });
});

describe("a repo's .testlane.toml, over MCP: effective config and branch names", () => {
  function repoState(env: Harness): { repoConfig?: { sha256: string; content: string } } | null {
    const file = join(env.stateHome, "testlane", "app.json");
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  }
  const originMain = (env: Harness) =>
    spawnSync("git", ["-C", env.repoPath("app"), "rev-parse", "refs/remotes/origin/main"], { encoding: "utf8" }).stdout.trim();

  it("C11 — a crafted branch ref is refused and leaves origin/main where it was", async () => {
    origin.commit("main", { ".testlane.toml": `[hooks]\npost_checkout = "echo main > {data_dir}/hook.txt"\n` });
    origin.commit("evil", { ".testlane.toml": `[hooks]\npost_checkout = "echo pwned > {data_dir}/../PWNED.txt"\n` });
    origin.makePr(7, "evil");
    const env = makeMcpEnv({ app: "" });
    expect((await env.run(["--yes", "config", "trust", "app"])).code).toBe(0);
    const before = originMain(env);
    expect(before).toMatch(/^[0-9a-f]{40}$/);

    const c = connect(env);
    await c.initialize();
    const r = await c.call("checkout", { project: "app", ref: "+refs/pull/7/head:refs/remotes/origin/main", kind: "branch" });
    expect(r.isError, JSON.stringify(r.value)).toBe(true);
    expect(r.value.error).toMatchObject({ errCode: "E_RESOLVE", exitCode: 4 });
    expect(originMain(env)).toBe(before);

    // A later scripted run still reads main's file, not PR 7's.
    expect((await env.run(["--yes", "app", "feature-x", "checkout"])).code).toBe(0);
    expect(existsSync(join(env.worktreesPath("app"), ".data", "PWNED.txt"))).toBe(false);
    expect(await c.close()).toBe(0);
  });

  it("C12 — a repo-only command starts after `config trust`", async () => {
    origin.commit("main", { ".testlane.toml": `[commands.srv]\nrun = ${JSON.stringify(SERVER)}\n` });
    const env = makeMcpEnv({ app: "" });
    expect((await env.run(["--yes", "config", "trust", "app"])).code).toBe(0);

    const c = connect(env);
    await c.initialize();
    const st = await c.call("start", { project: "app", ref: "main", command: "srv", timeout: 20 });
    expect(st.isError, JSON.stringify(st.value)).toBe(false);
    expect(await httpGet(st.value.port)).toBe("ok");
    expect((await c.call("stop", { project: "app", ref: "main" })).isError).toBe(false);
    expect(await c.close()).toBe(0);
  });

  it("C12 — rm runs the approved repo pre_clean", async () => {
    const marker = join(tmp, "pre-clean-ran.txt");
    origin.commit("main", { ".testlane.toml": `[hooks]\npre_clean = ${JSON.stringify(`echo {slug} > '${marker}'`)}\n` });
    const env = makeMcpEnv({ app: "" });
    expect((await env.run(["--yes", "config", "trust", "app"])).code).toBe(0);
    expect(repoState(env)?.repoConfig).toBeDefined();

    const c = connect(env);
    await c.initialize();
    const co = await c.call("checkout", { project: "app", ref: "feature-x" });
    expect(co.isError, JSON.stringify(co.value)).toBe(false);
    const gone = await c.call("rm", { project: "app", ref: "feature-x" });
    expect(gone.isError, JSON.stringify(gone.value)).toBe(false);
    expect(existsSync(co.value.path)).toBe(false);
    expect(readFileSync(marker, "utf8").trim()).toBe("feature-x");
    expect(await c.close()).toBe(0);
  });
});

describe("a crafted branch ref named HEAD, over MCP", () => {
  it("C11 — checkout of HEAD is refused and leaves origin/main where it was", async () => {
    origin.commit("main", { ".testlane.toml": `[hooks]\npost_checkout = "echo main > {data_dir}/hook.txt"\n` });
    const evil = origin.commit("evil", { ".testlane.toml": `[hooks]\npost_checkout = "echo pwned > {data_dir}/../PWNED.txt"\n` });
    const env = makeMcpEnv({ app: "" });
    expect((await env.run(["--yes", "config", "trust", "app"])).code).toBe(0);
    spawnSync("git", ["-C", origin.path, "update-ref", "refs/heads/HEAD", evil]);
    const originMain = () =>
      spawnSync("git", ["-C", env.repoPath("app"), "rev-parse", "refs/remotes/origin/main"], { encoding: "utf8" }).stdout.trim();
    const before = originMain();

    const c = connect(env);
    await c.initialize();
    for (const args of [{ ref: "HEAD", kind: "branch" }, { ref: "HEAD" }]) {
      const r = await c.call("checkout", { project: "app", ...args });
      expect(r.isError, JSON.stringify(r.value)).toBe(true);
      expect(r.value.error).toMatchObject({ errCode: "E_RESOLVE", exitCode: 4 });
      expect(originMain()).toBe(before);
    }
    expect(await c.close()).toBe(0);
  });
});

describe("a crafted branch ref that differs from origin/main only in case, over MCP", () => {
  it("C11 — checkout of Main or head leaves origin/main where it was", async () => {
    origin.commit("main", { ".testlane.toml": `[hooks]\npost_checkout = "echo main > {data_dir}/hook.txt"\n` });
    const evil = origin.commit("evil", { ".testlane.toml": `[hooks]\npost_checkout = "echo pwned > {data_dir}/../PWNED.txt"\n` });
    const env = makeMcpEnv({ app: "" });
    expect((await env.run(["--yes", "config", "trust", "app"])).code).toBe(0);
    // A case-sensitive origin even on a case-insensitive disk (see repo-config.test.ts).
    spawnSync("git", ["-C", origin.path, "refs", "migrate", "--ref-format=reftable"]);
    for (const name of ["Main", "head"]) {
      expect(spawnSync("git", ["-C", origin.path, "update-ref", `refs/heads/${name}`, evil]).status).toBe(0);
    }
    const git = (...args: string[]) => spawnSync("git", ["-C", env.repoPath("app"), ...args], { encoding: "utf8" }).stdout.trim();
    const before = git("rev-parse", "refs/remotes/origin/main");
    const ignoresCase = git("config", "--bool", "core.ignorecase") === "true";

    const c = connect(env);
    await c.initialize();
    for (const args of [{ ref: "Main", kind: "branch" }, { ref: "Main" }, { ref: "head", kind: "branch" }, { ref: "head" }]) {
      const r = await c.call("checkout", { project: "app", ...args });
      expect(git("rev-parse", "refs/remotes/origin/main"), JSON.stringify(args)).toBe(before);
      if (args.ref === "head" || ignoresCase) {
        expect(r.isError, JSON.stringify(r.value)).toBe(true);
        expect(r.value.error).toMatchObject({ errCode: "E_RESOLVE", exitCode: 4 });
      }
    }
    expect(await c.close()).toBe(0);
  });
});
