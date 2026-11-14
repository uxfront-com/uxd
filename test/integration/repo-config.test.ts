// §5.7 integration: a repo's `.testlane.toml` on a real fixture origin — where
// it is read from, trust, merge, `config add <url>`, `config show`, `doctor`.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeEnv, makeFixtureOrigin, type FixtureOrigin, type Harness } from "../fixtures.ts";

const MAIN_FILE = [
  `[commands.which]`,
  `run = "echo main > {data_dir}/which.txt"`,
  `[hooks]`,
  `post_checkout = "echo main > {data_dir}/hook.txt"`,
  ``,
].join("\n");

let tmp: string;
let origin: FixtureOrigin;
let env: Harness;

const sha256 = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

beforeEach(() => {
  // realpath: on macOS $TMPDIR is a symlink, and git prints resolved paths.
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "testlane-repocfg-")));
  origin = makeFixtureOrigin(tmp);
  origin.commit("main", { "README.md": "# fixture\n", ".testlane.toml": MAIN_FILE });
  env = makeEnv(tmp, { app: { repo: origin.url, defaultBranch: "main" } });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface StateFile {
  repoConfig?: { sha256: string; blob: string; content: string; approvedAt: string };
  workspaces: Record<string, { path: string }>;
}

function state(project = "app"): StateFile | null {
  const file = join(env.stateHome, "testlane", `${project}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as StateFile) : null;
}

const dataDir = (slug: string) => join(env.worktreesPath("app"), ".data", slug);
const readData = (slug: string, file: string) => readFileSync(join(dataDir(slug), file), "utf8").trim();

function fetchMain(): void {
  const res = spawnSync("git", ["-C", env.repoPath("app"), "fetch", "-q", "origin", "main"]);
  expect(res.status).toBe(0);
}

describe("where the file is read from", () => {
  it("a PR that edits .testlane.toml changes no command, hook or setup that runs", async () => {
    expect((await env.run(["--yes", "app", "main", "checkout"])).code).toBe(0);
    const approved = state()!.repoConfig!.sha256;

    origin.commit("agent/pwn", {
      ".testlane.toml": [
        `[setup]`,
        `run = "touch {data_dir}/pwned"`,
        MAIN_FILE.replaceAll("echo main", "echo pr"),
      ].join("\n"),
    });
    origin.makePr(7, "agent/pwn");

    const r = await env.run(["app", "7", "run", "which"]);
    expect(r.code, r.stderr).toBe(0);
    expect(readData("pr-7", "which.txt")).toBe("main");
    expect(readData("pr-7", "hook.txt")).toBe("main");
    expect(existsSync(join(dataDir("pr-7"), "pwned"))).toBe(false);
    expect(state()!.repoConfig!.sha256).toBe(approved);
  });

  it("a branch checkout reads origin/<default>, not the branch's copy", async () => {
    origin.commit("feature", { ".testlane.toml": `[setup]\nrun = "touch {data_dir}/pwned"\n` });
    const r = await env.run(["--yes", "app", "feature", "checkout"]);
    expect(r.code).toBe(0);
    expect(state()!.repoConfig!.content).toBe(MAIN_FILE);
  });
});

describe("trust", () => {
  it("untrusted: a non-TTY run without --yes fails and creates nothing", async () => {
    const r = await env.run(["app", "main", "checkout"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("error(E_CONFIG): app:.testlane.toml is not trusted");
    expect(r.stderr).toContain("hint: testlane config trust app");
    expect(existsSync(join(env.worktreesPath("app"), "main"))).toBe(false);
    expect(state()?.repoConfig).toBeUndefined();
  });

  it("untrusted: a PR checkout is gated too", async () => {
    origin.commit("agent/x", { "x.txt": "x\n" });
    origin.makePr(7, "agent/x");
    const r = await env.run(["app", "7", "checkout"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("app:.testlane.toml is not trusted");
    expect(existsSync(join(env.worktreesPath("app"), "pr-7"))).toBe(false);
  });

  it("an approval survives a failing setup in the same run", async () => {
    expect((await env.run(["--yes", "app", "main", "checkout"])).code).toBe(0);
    const v2 = `[setup]\nrun = "exit 1"\n` + MAIN_FILE;
    origin.commit("main", { ".testlane.toml": v2 });
    const r = await env.run(["--yes", "app", "main", "checkout", "--fetch", "--setup"]);
    expect(r.code).toBe(6);
    expect(state()!.repoConfig!.sha256).toBe(sha256(v2));
  });

  it("--yes approves and stores the sha256 of the file bytes", async () => {
    const r = await env.run(["--yes", "app", "main", "checkout"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(join(env.worktreesPath("app"), "main")); // stdout contract holds
    expect(state()!.repoConfig!.sha256).toBe(sha256(MAIN_FILE));
    expect(state()!.repoConfig!.content).toBe(MAIN_FILE);
    expect(readData("main", "hook.txt")).toBe("main"); // the approved post_checkout ran
  });

  it("changed file asks again", async () => {
    expect((await env.run(["--yes", "app", "main", "checkout"])).code).toBe(0);
    const v2 = MAIN_FILE.replace("echo main > {data_dir}/which.txt", "echo v2 > {data_dir}/which.txt");
    origin.commit("main", { ".testlane.toml": v2 });

    const refused = await env.run(["app", "main", "checkout", "--fetch"]);
    expect(refused.code).toBe(3);
    expect(refused.stderr).toContain("error(E_CONFIG): app:.testlane.toml changed since you trusted it");
    expect(refused.stderr).toContain("hint: testlane config trust app");
    expect(state()!.repoConfig!.sha256).toBe(sha256(MAIN_FILE));

    const ok = await env.run(["--yes", "app", "main", "checkout", "--fetch"]);
    expect(ok.code).toBe(0);
    expect(ok.stderr).toContain("+run = \"echo v2 > {data_dir}/which.txt\""); // the diff is shown
    expect(state()!.repoConfig!.sha256).toBe(sha256(v2));
  });

  it("the fast path stays offline and needs no answer once trusted", async () => {
    expect((await env.run(["--yes", "app", "main", "checkout"])).code).toBe(0);
    // The origin goes away: an unchanged tip compares blob ids only.
    rmSync(origin.path, { recursive: true, force: true });
    const r = await env.run(["app", "main", "checkout"]);
    expect(r.code).toBe(0);
  });

  it("config trust", async () => {
    const refused = await env.run(["config", "trust", "app"]);
    expect(refused.code).toBe(3);
    expect(refused.stderr).toContain("app:.testlane.toml is not trusted");
    expect(refused.stderr).toContain("hint: re-run on a terminal, or pass --yes");
    expect(refused.stderr).toContain(MAIN_FILE.split("\n")[1]!); // the file is shown
    expect(state()?.repoConfig).toBeUndefined();

    const ok = await env.run(["--yes", "config", "trust", "app"]);
    expect(ok.code).toBe(0);
    expect(state()!.repoConfig!.sha256).toBe(sha256(MAIN_FILE));

    const again = await env.run(["config", "trust", "app"]);
    expect(again.code).toBe(0);
    expect(again.stderr).toContain("already trusted");
  });

  it("config trust on a repo with no file says so and exits 0", async () => {
    origin.remove("main", [".testlane.toml"]);
    const r = await env.run(["config", "trust", "app"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("no .testlane.toml on origin/main");
  });

  it("a file removed upstream drops the approval on the next run that fetches it", async () => {
    expect((await env.run(["--yes", "app", "main", "checkout"])).code).toBe(0);
    origin.remove("main", [".testlane.toml"]);
    const r = await env.run(["app", "main", "checkout", "--fetch"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("app:.testlane.toml is gone from origin/main; dropped its approval");
    expect(state()!.repoConfig).toBeUndefined();
  });

  it("a broken file at the tip fails the run with every issue (A4)", async () => {
    origin.commit("main", { ".testlane.toml": `editor = "zed"\nbase_port = 5000\n` });
    const r = await env.run(["--yes", "app", "main", "checkout"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("app:.testlane.toml: editor: user-only key; set it in app.toml");
    expect(r.stderr).toContain("app:.testlane.toml: base_port: user-only key; set it in app.toml");
  });

  it("run re-checks the command after the gate approves a change that drops it", async () => {
    expect((await env.run(["--yes", "config", "trust", "app"])).code).toBe(0);
    expect((await env.run(["app", "main", "checkout"])).code).toBe(0);
    origin.commit("main", { ".testlane.toml": `[commands.other]\nrun = "true"\n` });
    const r = await env.run(["--yes", "app", "main", "run", "which", "--fetch"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("error(E_USAGE): unknown command 'which'");
  });

  it("--dry-run skips the gate", async () => {
    const r = await env.run(["--dry-run", "app", "main", "checkout"]);
    expect(r.code).toBe(0);
    expect(state()?.repoConfig).toBeUndefined();
  });
});

describe("merge", () => {
  it("repo file applies", async () => {
    expect((await env.run(["--yes", "config", "trust", "app"])).code).toBe(0);
    const r = await env.run(["app", "main", "run", "which"]);
    expect(r.code).toBe(0);
    expect(readData("main", "which.txt")).toBe("main");
    expect(readData("main", "hook.txt")).toBe("main");
  });

  it("user override wins", async () => {
    env = makeEnv(tmp, {
      app: {
        repo: origin.url,
        defaultBranch: "main",
        extraToml: `[commands.which]\nrun = "echo user > {data_dir}/which.txt"`,
      },
    });
    expect((await env.run(["--yes", "config", "trust", "app"])).code).toBe(0);
    const r = await env.run(["app", "main", "run", "which"]);
    expect(r.code).toBe(0);
    expect(readData("main", "which.txt")).toBe("user");
    expect(readData("main", "hook.txt")).toBe("main"); // the repo hook still merges in
  });

  it("without approval the user file works on its own", async () => {
    env = makeEnv(tmp, {
      app: { repo: origin.url, defaultBranch: "main", extraToml: `[commands.mine]\nrun = "echo mine > {data_dir}/mine.txt"` },
    });
    // Declining isn't possible off a TTY, so prove it on the parse-time view:
    // the repo command is unknown until approved, the user's command is there.
    const unknown = await env.run(["app", "main", "which"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("configured commands: mine");
  });
});

describe("config show", () => {
  it("prints the merged config with each key's source", async () => {
    expect((await env.run(["--yes", "config", "trust", "app"])).code).toBe(0);

    const json = await env.run(["--json", "config", "show", "app"]);
    expect(json.code).toBe(0);
    const doc = JSON.parse(json.stdout) as {
      project: string;
      approved: { sha256: string; approvedAt: string } | null;
      config: Record<string, unknown>;
      sources: Record<string, string>;
    };
    expect(Object.keys(doc).sort()).toEqual(["approved", "config", "project", "sources"]);
    expect(doc.project).toBe("app");
    expect(doc.approved?.sha256).toBe(sha256(MAIN_FILE));
    expect(doc.sources["commands.which"]).toBe("repo");
    expect(doc.sources.repo).toBe("user");
    expect(doc.sources.editor).toBe("default");
    expect(doc.config.repo).toBe(origin.url);
    expect((doc.config.commands as Record<string, { run: string }>).which!.run).toContain("echo main");
    expect(doc.config.default_branch).toBe("main");

    const human = await env.run(["config", "show", "app"]);
    expect(human.code).toBe(0);
    const lines = human.stdout.trimEnd().split("\n");
    for (const line of lines) expect(line).toMatch(/  # (user|repo|default)$/);
    expect(lines.find((l) => l.startsWith("commands.which.run ="))).toMatch(/# repo$/);
    expect(lines.find((l) => l.startsWith("repo ="))).toMatch(/# user$/);
  });

  it("shows approved: null and the user file alone before approval", async () => {
    const r = await env.run(["--json", "config", "show", "app"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout) as { approved: unknown; sources: Record<string, string> };
    expect(doc.approved).toBeNull();
    expect(doc.sources["commands.which"]).toBeUndefined();
  });

  it("needs a known project", async () => {
    expect((await env.run(["config", "show", "nope"])).code).toBe(2);
    expect((await env.run(["config", "show"])).code).toBe(2);
  });
});

describe("doctor", () => {
  type Doc = { checks: Array<{ name: string; status: string; detail: string }> };
  const repoCheck = async () => {
    const r = await env.run(["--json", "doctor"]);
    return (JSON.parse(r.stdout) as Doc).checks.find((c) => c.name === "project app: repo file");
  };

  it("reports a repo file as not cloned, untrusted, trusted and changed", async () => {
    expect(await repoCheck()).toMatchObject({ status: "ok", detail: "not cloned yet" });

    expect((await env.run(["app", "main", "checkout"])).code).toBe(3); // clones, then refuses
    expect(await repoCheck()).toMatchObject({ status: "warn" });
    expect((await repoCheck())!.detail).toContain("untrusted");

    expect((await env.run(["--yes", "config", "trust", "app"])).code).toBe(0);
    expect(await repoCheck()).toMatchObject({ status: "ok" });
    expect((await repoCheck())!.detail).toContain("trusted");

    origin.commit("main", { ".testlane.toml": MAIN_FILE + "# v2\n" });
    fetchMain();
    expect(await repoCheck()).toMatchObject({ status: "warn" });
    expect((await repoCheck())!.detail).toContain("changed");
  });

  it("fails when the stored snapshot no longer validates", async () => {
    expect((await env.run(["--yes", "config", "trust", "app"])).code).toBe(0);
    const file = join(env.stateHome, "testlane", "app.json");
    const s = JSON.parse(readFileSync(file, "utf8")) as StateFile;
    s.repoConfig!.content = `editor = "zed"\n`;
    s.repoConfig!.sha256 = sha256(s.repoConfig!.content);
    writeFileSync(file, JSON.stringify(s));

    expect(await repoCheck()).toMatchObject({ status: "fail" });
    const v = await env.run(["config", "validate"]);
    expect(v.code).toBe(3);
    expect(v.stderr).toContain("app:.testlane.toml: editor: user-only key");
  });
});

describe("state reads never break config-only commands", () => {
  it("a corrupt state file means no snapshot for projects, config validate and config show", async () => {
    mkdirSync(join(env.stateHome, "testlane"), { recursive: true });
    writeFileSync(join(env.stateHome, "testlane", "app.json"), "{not json");
    expect((await env.run(["projects"])).code).toBe(0);
    expect((await env.run(["config", "validate"])).code).toBe(0);
    expect((await env.run(["config", "validate", "app"])).code).toBe(0);
    expect((await env.run(["config", "show", "app"])).code).toBe(0);
  });
});

describe("config add", () => {
  const URL = "https://github.com/acme/app";
  const CLONE = "https://github.com/acme/app.git";
  let plain: FixtureOrigin;
  const saved: Record<string, string | undefined> = {};
  const setEnv = (key: string, value: string) => {
    if (!(key in saved)) saved[key] = process.env[key];
    process.env[key] = value;
  };

  beforeEach(() => {
    plain = makeFixtureOrigin(join(tmp, "plain"));
    plain.commit("main", { "README.md": "# plain\n" });
    // Map the fake web URLs onto the fixture origins. `insteadOf` replaces a
    // prefix, so each value is the exact clone URL `config add` writes.
    setEnv("GIT_CONFIG_COUNT", "3");
    setEnv("GIT_CONFIG_KEY_0", `url.${origin.url}.insteadOf`);
    setEnv("GIT_CONFIG_VALUE_0", CLONE);
    setEnv("GIT_CONFIG_KEY_1", `url.${plain.url}.insteadOf`);
    setEnv("GIT_CONFIG_VALUE_1", "https://github.com/acme/plain.git");
    setEnv("GIT_CONFIG_KEY_2", `url.file://${join(tmp, "nowhere.git")}.insteadOf`);
    setEnv("GIT_CONFIG_VALUE_2", "https://github.com/acme/missing.git");
    setEnv("EDITOR", "true");
    env = makeEnv(tmp, {});
    rmSync(join(env.configDir, "app.toml")); // from the outer beforeEach: config add starts with no project
    writeFileSync(join(env.configDir, "defaults.toml"), `root = ${JSON.stringify(join(tmp, "root"))}\n`);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      delete saved[key];
    }
  });

  const isBare = (dir: string) =>
    spawnSync("git", ["-C", dir, "rev-parse", "--is-bare-repository"]).stdout.toString().trim() === "true";

  it("(a) a URL writes a repo line, clones, and trusts with --yes", async () => {
    const r = await env.run(["--yes", "config", "add", URL]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(env.configDir, "app.toml"), "utf8")).toBe(`repo = "${CLONE}"\n`);
    expect(isBare(join(tmp, "root", "app", "repo"))).toBe(true);
    expect(state()!.repoConfig!.sha256).toBe(sha256(MAIN_FILE));
    expect(r.stderr).toContain("would run:");
    expect(r.stderr).toContain("next: testlane app main");
  });

  it("(a) a /pull/ or /tree/ URL clones the repo itself", async () => {
    const r = await env.run(["--yes", "config", "add", `${URL}/pull/12`]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(env.configDir, "app.toml"), "utf8")).toBe(`repo = "${CLONE}"\n`);
  });

  it("(b) --name overrides the derived name", async () => {
    const r = await env.run(["--yes", "config", "add", URL, "--name", "other"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(env.configDir, "other.toml"))).toBe(true);
    expect(existsSync(join(env.configDir, "app.toml"))).toBe(false);
    expect(isBare(join(tmp, "root", "other", "repo"))).toBe(true);
    expect(state("other")!.repoConfig).toBeDefined();
  });

  it("(c) without a repo file it writes the template with the real repo line and opens the editor", async () => {
    const r = await env.run(["config", "add", "https://github.com/acme/plain"]);
    expect(r.code).toBe(0);
    const body = readFileSync(join(env.configDir, "plain.toml"), "utf8");
    expect(body).toContain(`repo = "https://github.com/acme/plain.git"   # required`);
    expect(body).toContain("testlane config validate plain");
    expect(isBare(join(tmp, "root", "plain", "repo"))).toBe(true);
    expect((await env.run(["config", "validate", "plain"])).code).toBe(0);
  });

  it("(d) --dry-run writes nothing and clones nothing", async () => {
    const r = await env.run(["--dry-run", "config", "add", URL]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`write ${join(env.configDir, "app.toml")}`);
    expect(r.stdout).toContain(`repo = "${CLONE}"`);
    expect(r.stdout).toContain(`git clone --bare --filter=blob:none ${CLONE} ${join(tmp, "root", "app", "repo")}`);
    expect(existsSync(join(env.configDir, "app.toml"))).toBe(false);
    expect(existsSync(join(tmp, "root"))).toBe(false);
  });

  it("(e) an existing project file exits 3 and changes nothing", async () => {
    writeFileSync(join(env.configDir, "app.toml"), "repo = \"keep\"\n");
    const r = await env.run(["--yes", "config", "add", URL]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("project 'app' already exists");
    expect(readFileSync(join(env.configDir, "app.toml"), "utf8")).toBe("repo = \"keep\"\n");
    expect(existsSync(join(tmp, "root"))).toBe(false);
  });

  it("(f) no defaults.root and no --root exits 3 and writes nothing", async () => {
    rmSync(join(env.configDir, "defaults.toml"));
    const r = await env.run(["--yes", "config", "add", URL]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("hint: pass --root <dir>, for example --root ~/dev/testlane");
    expect(existsSync(join(env.configDir, "app.toml"))).toBe(false);
    expect(existsSync(join(env.configDir, "defaults.toml"))).toBe(false);
  });

  it("(g) on a new machine --root creates the config dir, defaults.toml and the project", async () => {
    rmSync(env.configDir, { recursive: true, force: true });
    const root = join(tmp, "root2");
    // --root before the URL: the config-dir guard must still find the URL.
    const r = await env.run(["--yes", "config", "add", "--root", root, URL]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(env.configDir, "defaults.toml"), "utf8")).toBe(`root = ${JSON.stringify(root)}\n`);
    expect(readFileSync(join(env.configDir, "app.toml"), "utf8")).toBe(`repo = "${CLONE}"\n`);
    expect(isBare(join(root, "app", "repo"))).toBe(true);
  });

  it("--root that conflicts with defaults.root is a usage error; the same root is fine", async () => {
    const clash = await env.run(["--yes", "config", "add", URL, "--root", join(tmp, "elsewhere")]);
    expect(clash.code).toBe(2);
    expect(clash.stderr).toContain("conflicts with defaults.root");
    expect(existsSync(join(env.configDir, "app.toml"))).toBe(false);

    const same = await env.run(["--yes", "config", "add", URL, "--root", join(tmp, "root")]);
    expect(same.code).toBe(0);
  });

  it("a failed clone removes the project file it wrote and exits 5", async () => {
    const r = await env.run(["--yes", "config", "add", "https://github.com/acme/missing"]);
    expect(r.code).toBe(5);
    expect(existsSync(join(env.configDir, "missing.toml"))).toBe(false);
    expect(existsSync(join(tmp, "root", "missing", "repo"))).toBe(false);
  });

  it("off a terminal without --yes it keeps the project and asks for config trust", async () => {
    const r = await env.run(["config", "add", URL]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("app:.testlane.toml is not trusted");
    expect(r.stderr).toContain("hint: testlane config trust app");
    expect(existsSync(join(env.configDir, "app.toml"))).toBe(true);
    expect(state()?.repoConfig).toBeUndefined();
  });

  it("an invalid derived name asks for --name", async () => {
    const r = await env.run(["config", "add", "https://github.com/acme/Seeds"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("pass --name <name>");
  });

  it("--name and --root belong to config add <url> only", async () => {
    const r = await env.run(["config", "add", "fresh", "--name", "x"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown flag '--name'");
    expect(existsSync(join(env.configDir, "fresh.toml"))).toBe(false);
  });
});

describe("unusable approvals and more gated paths", () => {
  it("a tampered approval: the run asks for trust, config trust repairs it, config-only commands keep working", async () => {
    env = makeEnv(tmp, {
      app: { repo: origin.url, defaultBranch: "main", extraToml: `[commands.mine]\nrun = "echo mine > {data_dir}/mine.txt"` },
    });
    expect((await env.run(["--yes", "app", "main", "checkout"])).code).toBe(0);
    const file = join(env.stateHome, "testlane", "app.json");
    const s = JSON.parse(readFileSync(file, "utf8")) as StateFile;
    s.repoConfig!.content += "# tampered\n";
    writeFileSync(file, JSON.stringify(s));

    const blocked = await env.run(["app", "main", "run", "mine"]);
    expect(blocked.code).toBe(3);
    expect(blocked.stderr).toContain("is unusable (the approved snapshot does not match its sha256)");
    expect(blocked.stderr).toContain("hint: testlane config trust app");

    // Commands that only read config treat it as no snapshot.
    const projects = await env.run(["--json", "projects"]);
    expect((JSON.parse(projects.stdout) as Array<{ repo: string }>)[0]!.repo).toBe(origin.url);
    expect((await env.run(["--json", "config", "show", "app"])).code).toBe(0);
    expect((await env.run(["config", "validate", "app"])).code).toBe(3);

    const repaired = await env.run(["--yes", "config", "trust", "app"]);
    expect(repaired.code).toBe(0);
    expect(repaired.stderr).toContain("would run:");
    expect(state()!.repoConfig!.content).toBe(MAIN_FILE);

    expect((await env.run(["app", "main", "run", "mine"])).code).toBe(0);
    expect((await env.run(["config", "validate", "app"])).code).toBe(0);
  });

  it("URL routing still finds a project whose approval is unusable", async () => {
    env = makeEnv(tmp, { app: { repo: "https://github.com/acme/app.git", defaultBranch: "main" } });
    mkdirSync(join(env.stateHome, "testlane"), { recursive: true });
    const content = `editor = "zed"\n`;
    writeFileSync(
      join(env.stateHome, "testlane", "app.json"),
      JSON.stringify({ version: 1, workspaces: {}, repoConfig: { sha256: sha256(content), blob: "b", content, approvedAt: "x" } }),
    );
    const r = await env.run(["--dry-run", "https://github.com/acme/app/tree/main", "checkout"]);
    expect(r.code, r.stderr).toBe(0);
  });

  it("untrusted: a commit-ref checkout is gated", async () => {
    const sha = origin.commit("main", { "c.txt": "c\n" });
    const r = await env.run(["app", sha, "checkout"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("app:.testlane.toml is not trusted");
    expect(existsSync(join(env.worktreesPath("app"), `sha-${sha.slice(0, 10)}`))).toBe(false);
  });

  it("untrusted: an adopted path is gated once the primary repo exists", async () => {
    expect((await env.run(["app", "main", "checkout"])).code).toBe(3); // clones, then refuses
    const adopted = join(tmp, "adopted");
    expect(spawnSync("git", ["init", "-q", adopted]).status).toBe(0);
    const r = await env.run(["app", "--path", adopted, "checkout"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("app:.testlane.toml is not trusted");
    expect(state()?.workspaces ?? {}).toEqual({});
  });

  it("start re-checks the command after the gate approves a change that drops it", async () => {
    expect((await env.run(["--yes", "config", "trust", "app"])).code).toBe(0);
    expect((await env.run(["app", "main", "checkout"])).code).toBe(0);
    origin.commit("main", { ".testlane.toml": `[commands.other]\nrun = "true"\n` });
    const r = await env.run(["--yes", "app", "main", "start", "which", "--fetch"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("error(E_USAGE): unknown command 'which'");
  });

  it("config trust fetches the default branch, so it sees an upstream change", async () => {
    expect((await env.run(["--yes", "config", "trust", "app"])).code).toBe(0);
    const v2 = MAIN_FILE + "# v2\n";
    origin.commit("main", { ".testlane.toml": v2 });
    const asked = await env.run(["config", "trust", "app"]);
    expect(asked.code).toBe(3);
    expect(asked.stderr).toContain("app:.testlane.toml changed since you trusted it");
    expect(asked.stderr).toContain("+# v2");
    expect((await env.run(["--yes", "config", "trust", "app"])).code).toBe(0);
    expect(state()!.repoConfig!.sha256).toBe(sha256(v2));
  });

  it("doctor warns when the file is removed upstream with an approval stored", async () => {
    expect((await env.run(["--yes", "config", "trust", "app"])).code).toBe(0);
    origin.remove("main", [".testlane.toml"]);
    fetchMain();
    const r = await env.run(["--json", "doctor"]);
    const check = (JSON.parse(r.stdout) as { checks: Array<{ name: string; status: string; detail: string }> }).checks.find(
      (c) => c.name === "project app: repo file",
    );
    expect(check).toMatchObject({ status: "warn" });
    expect(check!.detail).toContain("removed upstream");
  });

  it("config show --json carries approvedAt", async () => {
    expect((await env.run(["--yes", "config", "trust", "app"])).code).toBe(0);
    const doc = JSON.parse((await env.run(["--json", "config", "show", "app"])).stdout) as {
      approved: { approvedAt: string };
    };
    expect(doc.approved.approvedAt).toBe(state()!.repoConfig!.approvedAt);
    expect(Number.isNaN(Date.parse(doc.approved.approvedAt))).toBe(false);
  });
});

describe("config add: names, leftovers and rollback", () => {
  const saved: Record<string, string | undefined> = {};
  const setEnv = (key: string, value: string) => {
    if (!(key in saved)) saved[key] = process.env[key];
    process.env[key] = value;
  };
  let plain: FixtureOrigin;

  beforeEach(() => {
    plain = makeFixtureOrigin(join(tmp, "plain"));
    plain.commit("main", { "README.md": "# plain\n" });
    setEnv("GIT_CONFIG_COUNT", "2");
    setEnv("GIT_CONFIG_KEY_0", `url.${plain.url}.insteadOf`);
    setEnv("GIT_CONFIG_VALUE_0", "https://github.com/acme/plain.git");
    setEnv("GIT_CONFIG_KEY_1", `url.file://${join(tmp, "nowhere.git")}.insteadOf`);
    setEnv("GIT_CONFIG_VALUE_1", "https://github.com/acme/missing.git");
    env = makeEnv(tmp, {});
    rmSync(join(env.configDir, "app.toml"));
    writeFileSync(join(env.configDir, "defaults.toml"), `root = ${JSON.stringify(join(tmp, "root"))}\n`);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      delete saved[key];
    }
  });

  it("(c) opens the editor on the seeded template", async () => {
    setEnv("EDITOR", "touch {path}.opened");
    const r = await env.run(["config", "add", "https://github.com/acme/plain"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(env.configDir, "plain.toml.opened"))).toBe(true);
  });

  it("derives the name from a URL with a trailing slash and a .git suffix", async () => {
    const r = await env.run(["--dry-run", "config", "add", "https://github.com/acme/My_App.git/"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`write ${join(env.configDir, "my_app.toml")}`);
    expect(r.stdout).toContain(`repo = "https://github.com/acme/My_App.git"`);
  });

  it("a leftover state file from an earlier project of the same name lends no approval", async () => {
    setEnv("EDITOR", "true");
    mkdirSync(join(env.stateHome, "testlane"), { recursive: true });
    const content = `[commands.old]\nrun = "true"\n`;
    writeFileSync(
      join(env.stateHome, "testlane", "plain.json"),
      JSON.stringify({ version: 1, workspaces: {}, repoConfig: { sha256: sha256(content), blob: "b", content, approvedAt: "x" } }),
    );
    const r = await env.run(["config", "add", "https://github.com/acme/plain"]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(env.configDir, "plain.toml"), "utf8")).toContain("testlane config validate plain");
    expect(state("plain")!.repoConfig).toBeUndefined();
  });

  it("a failed clone on a new machine puts back the config dir, defaults.toml and root it created", async () => {
    rmSync(env.configDir, { recursive: true, force: true });
    const root = join(tmp, "root2");
    const r = await env.run(["--yes", "config", "add", "--root", root, "https://github.com/acme/missing"]);
    expect(r.code).toBe(5);
    expect(existsSync(env.configDir)).toBe(false);
    expect(existsSync(root)).toBe(false);
  });

  it("a leftover approval is dropped from disk even when the gate then refuses off a terminal", async () => {
    const other = makeFixtureOrigin(join(tmp, "other"));
    other.commit("main", { ".testlane.toml": `[commands.newcmd]\nrun = "true"\n` });
    setEnv("GIT_CONFIG_COUNT", "3");
    setEnv("GIT_CONFIG_KEY_2", `url.${other.url}.insteadOf`);
    setEnv("GIT_CONFIG_VALUE_2", "https://github.com/acme/other.git");
    mkdirSync(join(env.stateHome, "testlane"), { recursive: true });
    const content = `[commands.oldcmd]\nrun = "echo OLD-REPO-COMMAND"\n`;
    writeFileSync(
      join(env.stateHome, "testlane", "other.json"),
      JSON.stringify({ version: 1, workspaces: {}, repoConfig: { sha256: sha256(content), blob: "b", content, approvedAt: "x" } }),
    );

    const r = await env.run(["config", "add", "https://github.com/acme/other"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("other:.testlane.toml is not trusted");
    expect(r.stderr).not.toContain("changed since you trusted it");
    expect(state("other")!.repoConfig).toBeUndefined();

    const show = await env.run(["config", "show", "other"]);
    expect(show.stdout).not.toContain("oldcmd");
    const trust = await env.run(["config", "trust", "other"]);
    expect(trust.stderr).toContain("other:.testlane.toml is not trusted"); // first use, not a diff against the old file
  });

  it("a failed clone restores an existing defaults.toml it appended root to", async () => {
    writeFileSync(join(env.configDir, "defaults.toml"), `editor = "zed"\n`);
    const r = await env.run(["--yes", "config", "add", "--root", join(tmp, "root2"), "https://github.com/acme/missing"]);
    expect(r.code).toBe(5);
    expect(readFileSync(join(env.configDir, "defaults.toml"), "utf8")).toBe(`editor = "zed"\n`);
  });
});

describe("integration review fixes", () => {
  const originMain = () =>
    spawnSync("git", ["-C", env.repoPath("app"), "rev-parse", "refs/remotes/origin/main"], { encoding: "utf8" }).stdout.trim();

  it("C11 — a crafted branch ref exits 4 and can't move origin/main to a PR's head", async () => {
    origin.commit("feature", { "f.txt": "f\n" });
    origin.commit("evil", { ".testlane.toml": `[hooks]\npost_checkout = "echo pwned > {data_dir}/../PWNED.txt"\n` });
    origin.makePr(7, "evil");
    expect((await env.run(["--yes", "app", "main", "checkout"])).code).toBe(0);
    const before = originMain();
    expect(before).toMatch(/^[0-9a-f]{40}$/);

    const r = await env.run(["app", "--branch", "+refs/pull/7/head:refs/remotes/origin/main", "checkout"]);
    expect(r.code, r.stderr).toBe(4);
    expect(r.stderr).toContain("error(E_RESOLVE)");
    expect(originMain()).toBe(before);

    const next = await env.run(["--yes", "app", "feature", "checkout"]);
    expect(next.code, next.stderr).toBe(0);
    expect(existsSync(join(env.worktreesPath("app"), ".data", "PWNED.txt"))).toBe(false);
    expect(state()!.repoConfig!.content).toBe(MAIN_FILE);
  });

  it("C11 — --dry-run prints the explicit refspec the real fetch runs", async () => {
    const r = await env.run(["--dry-run", "app", "--branch", "feature/x", "checkout"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("fetch --no-tags origin --end-of-options +refs/heads/feature/x:refs/remotes/origin/feature/x");
  });

  it("C13 — control characters in repo file errors are escaped", async () => {
    // A key the schema refuses, so its path is quoted in the issue.
    origin.commit("main", { ".testlane.toml": `[env]\n"\\u001b]0;HIJACK\\u0007\\u001b[2K" = 1\n` });
    const keyed = await env.run(["app", "main", "checkout"]);
    // A raw ESC on a line the parser quotes.
    origin.commit("main", { ".testlane.toml": `[env\n\u001b[2K = "x"\n` });
    const parsed = await env.run(["app", "main", "checkout"]);

    for (const r of [keyed, parsed]) {
      expect(r.code, r.stderr).toBe(3);
      expect(r.stderr).toContain("app:.testlane.toml");
      expect(r.stderr).not.toContain("\u001b");
      expect(r.stderr).not.toContain("\u0007");
      expect(r.stderr).toContain("\\u001b");
    }
    expect(parsed.stderr).toContain("TOML parse error");
    expect(state()?.repoConfig).toBeUndefined();
  });

  it("C14 — default_command names a repo command: trust approves it", async () => {
    const withSrv = `[commands.srv]\nrun = "echo srv"\n` + MAIN_FILE;
    origin.commit("main", { ".testlane.toml": withSrv });
    env = makeEnv(tmp, { app: { repo: origin.url, defaultBranch: "main", extraToml: `default_command = "srv"` } });

    const before = await env.run(["app", "main", "checkout"]);
    expect(before.code, before.stderr).toBe(3);
    expect(before.stderr).toContain("default_command");
    expect(before.stderr).toContain("hint: testlane config trust app");

    const trust = await env.run(["--yes", "config", "trust", "app"]);
    expect(trust.code, trust.stderr).toBe(0);
    expect(state()!.repoConfig!.content).toBe(withSrv);

    const after = await env.run(["app", "main", "checkout"]);
    expect(after.code, after.stderr).toBe(0);
  });

  it("C14 — default_command names a command the tip lacks: trust records nothing", async () => {
    env = makeEnv(tmp, { app: { repo: origin.url, defaultBranch: "main", extraToml: `default_command = "srv"` } });

    const trust = await env.run(["--yes", "config", "trust", "app"]);
    expect(trust.code).toBe(3);
    expect(trust.stderr).toContain("error(E_CONFIG)");
    expect(trust.stderr).toContain("default_command");
    expect(state()?.repoConfig).toBeUndefined();
  });

  it("C14 — with no repo file, trust still reports the user's unknown default_command", async () => {
    origin.remove("main", [".testlane.toml"]);
    env = makeEnv(tmp, { app: { repo: origin.url, defaultBranch: "main", extraToml: `default_command = "srv"` } });

    const trust = await env.run(["--yes", "config", "trust", "app"]);
    expect(trust.code).toBe(3);
    expect(trust.stderr).toContain("default_command");
    expect(state()?.repoConfig).toBeUndefined();
  });
});

describe("a crafted branch ref named HEAD", () => {
  const originMain = () =>
    spawnSync("git", ["-C", env.repoPath("app"), "rev-parse", "refs/remotes/origin/main"], { encoding: "utf8" }).stdout.trim();

  it("C11 — a crafted branch ref: HEAD on origin can't move origin/main through the origin/HEAD symref", async () => {
    origin.commit("feature", { "f.txt": "f\n" });
    const evil = origin.commit("evil", { ".testlane.toml": `[hooks]\npost_checkout = "echo pwned > {data_dir}/../PWNED.txt"\n` });
    expect((await env.run(["--yes", "app", "main", "checkout"])).code).toBe(0);
    spawnSync("git", ["-C", origin.path, "update-ref", "refs/heads/HEAD", evil]);
    const before = originMain();

    for (const argv of [
      ["app", "--branch", "HEAD", "checkout"],
      ["app", "HEAD", "checkout"],
    ]) {
      const r = await env.run(argv);
      expect(r.code, `${argv.join(" ")}: ${r.stderr}`).toBe(4);
      expect(originMain()).toBe(before);
    }

    const next = await env.run(["--yes", "app", "feature", "checkout"]);
    expect(next.code, next.stderr).toBe(0);
    expect(existsSync(join(env.worktreesPath("app"), ".data", "PWNED.txt"))).toBe(false);
    expect(state()!.repoConfig!.content).toBe(MAIN_FILE);
  });
});

describe("a crafted branch ref that differs from origin/main only in case", () => {
  const originMain = () =>
    spawnSync("git", ["-C", env.repoPath("app"), "rev-parse", "refs/remotes/origin/main"], { encoding: "utf8" }).stdout.trim();
  const ignoresCase = () =>
    spawnSync("git", ["-C", env.repoPath("app"), "config", "--bool", "core.ignorecase"], { encoding: "utf8" }).stdout.trim() ===
    "true";

  it("C11 — a crafted branch ref like Main or head can't move origin/main on a case-insensitive filesystem", async () => {
    origin.commit("feature", { "f.txt": "f\n" });
    const evil = origin.commit("evil", { ".testlane.toml": `[hooks]\npost_checkout = "echo pwned > {data_dir}/../PWNED.txt"\n` });
    // Approve without a `main` workspace, whose slug a case variant would reuse.
    expect((await env.run(["--yes", "config", "trust", "app"])).code).toBe(0);
    // A case-sensitive origin, like GitHub's, even on this disk: reftable keeps refs in
    // one file. Where git can't migrate, the disk is case-sensitive in practice (Linux).
    spawnSync("git", ["-C", origin.path, "refs", "migrate", "--ref-format=reftable"]);
    for (const name of ["Main", "MAIN", "head", "Head"]) {
      expect(spawnSync("git", ["-C", origin.path, "update-ref", `refs/heads/${name}`, evil]).status).toBe(0);
    }
    const before = originMain();

    for (const name of ["Main", "MAIN", "head", "Head"]) {
      const r = await env.run(["app", "--branch", name, "checkout"]);
      expect(originMain(), name).toBe(before);
      // `head` is refused everywhere. A case variant of an existing branch is refused
      // where the filesystem would make it the same ref.
      if (/^head$/i.test(name) || ignoresCase()) {
        expect(r.code, `${name}: ${r.stderr}`).toBe(4);
        expect(r.stderr).toContain("error(E_RESOLVE)");
      }
    }

    const next = await env.run(["--yes", "app", "feature", "checkout"]);
    expect(next.code, next.stderr).toBe(0);
    expect(existsSync(join(env.worktreesPath("app"), ".data", "PWNED.txt"))).toBe(false);
    expect(state()!.repoConfig!.content).toBe(MAIN_FILE);
  });
});
