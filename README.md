# Testlane

Testlane lets you run any branch, pull request or commit of your project on your own machine with one command, in a workspace of its own. It turns a ref, like a PR number, a branch, a commit, a URL or a path, into a git worktree with ports of its own, and installs its dependencies and copies your seed files before it runs anything there. So you can start the app and try the change, while your own checkout stays as it was. The full documentation, with guides and a page for every command, is at [testlane.dev](https://testlane.dev).

```bash
testlane my-project 42 code          # PR #42, opened in your editor
testlane my-project 42 run dev       # the same workspace, its dev server running
testlane my-project clean --merged   # remove the workspaces whose PRs merged
```

Every workspace command takes the same three steps. It resolves the ref to a git target, materializes a worktree for it, then acts, by opening an editor, running a command or starting a shell:

```
resolve(ref) → materialize(workspace) → act(command)
```

## Install

Testlane runs on Node.js and shells out to git, so you'll need both:

| Tool                           | Version       | Required                                                                 |
| ------------------------------ | ------------- | ------------------------------------------------------------------------ |
| [Node.js](https://nodejs.org)  | 18 or later   | Yes                                                                      |
| `git`                          | 2.38 or later | Yes                                                                      |
| [`gh`](https://cli.github.com) | Any           | No, though it adds each PR's state and title, `gh pr diff` and push-back |

Every feature that uses `gh` falls back to plain git when `gh` is missing or not signed in, so you can add it later.

Testlane is published to npm as `@uxfront/testlane`, and it puts a `testlane` command on your `PATH`. We recommend installing it globally:

```bash
npm i -g @uxfront/testlane         # npm
pnpm add -g @uxfront/testlane      # pnpm
yarn global add @uxfront/testlane  # Yarn classic
```

Then check that your shell finds it:

```bash
testlane version
```

```
testlane 2.0.0
```

If your shell says `testlane: command not found`, your package manager's global `bin` directory isn't on your `PATH`. Add `$(npm prefix -g)/bin` for npm, `$(pnpm bin -g)` for pnpm or `$(yarn global bin)` for Yarn, then open a new shell. [`CHANGELOG.md`](CHANGELOG.md) lists what changed in each release.

To work on Testlane itself, install it from a clone. It ships as compiled JavaScript, so build `dist/` before you link it:

```bash
git clone git@github.com:uxfront-com/testlane.git
cd testlane
npm install
npm run build   # writes dist/bin/testlane.js, the file the command runs
npm link        # or `pnpm link --global` (after `pnpm setup`), or `yarn global add "file:$PWD"`
```

The linked command runs your clone's `dist/`, not its source, so run `npm run build` again after every `git pull`. To skip linking altogether, call the built entry point with Node, as in `node dist/bin/testlane.js version`, and put it in place of `testlane` in the examples below.

[Installation](https://testlane.dev/docs/getting-started/installation) on the site walks through each way to install it.

## Usage

Here's the smallest session that works, from a fresh install to a running workspace and back. We'll call the project `my-project` and the branch `feat/login`.

`setup` creates the config directory, `~/.testlane` by default, sets the base directory for clones and workspaces and writes your first project file. In a terminal it asks for each value, and each one is also a flag, so the same command runs without a prompt:

```bash
testlane setup --name my-project --repo git@github.com:my-org/my-project.git --yes
```

When the repository ships a `.testlane.toml`, you can skip writing the project file: `testlane config add https://github.com/my-org/my-project` writes it, clones the repository and asks you to trust the repository's setup and commands. [Repository config](#repository-config) says more.

`setup` writes only the repository, so open the file with `testlane config edit my-project` and tell Testlane how to install dependencies and what your commands are:

```toml
repo = "git@github.com:my-org/my-project.git"
default_branch = "main"
editor = "code"

[setup]
run = "pnpm install --frozen-lockfile"
cache_key = ["pnpm-lock.yaml"]

[env]
PORT = "{port}"

[commands.dev]
run = "pnpm dev"
```

`{port}` is the workspace's own port, so two dev servers never reach for the same one, and `default_branch` is the branch `diff` and `clean --merged` compare against. Check your tools and your project files with `doctor`, which exits with `1` when a check fails:

```bash
testlane doctor
```

Now open the branch. The first ref clones the repository once, as a bare, partial clone, and every ref after it reuses that clone. `checkout` prints the workspace's path on stdout and nothing else, so it works in a script:

```bash
testlane my-project feat/login checkout
cd "$(testlane my-project feat/login checkout)"
```

Keep in mind that a git worktree has a few quirks, like a `.git` file where tools expect a directory, and hooks that husky sets up can point the wrong way. [Known caveats](https://testlane.dev/docs/getting-started/workspaces#known-caveats) lists each one and what to do about it.

`run` opens the same workspace, runs the `[setup]` install, then runs a command from your project file inside it. The next `run` skips the install while the files in `cache_key` stay the same:

```bash
testlane my-project feat/login run dev
```

When you're done, see what you have and clean up. `clean` prints its plan and asks before it removes anything, and `--yes` answers for you:

```bash
testlane my-project list
testlane my-project clean --all --yes
```

A ref can also be a PR number like `42` or `#42`, a full 40-character commit SHA, a path to a working tree you already have, a repository URL in place of the project or `-` for the last ref you used. [Quick start](https://testlane.dev/docs/getting-started/quick-start) runs this session step by step, and [Refs](https://testlane.dev/docs/getting-started/refs) lists every kind of ref in the order Testlane tries them.

## Commands

Every command takes one of three forms, depending on what it acts on:

```
testlane [global flags] <project|url> <ref> [verb] [args] [-- passthrough]   # one workspace
testlane [global flags] <project> <project-verb> [args]                      # one project
testlane [global flags] <top-level-verb> [args]                              # Testlane itself
```

Everything after the first bare `--` goes to the underlying command, as it is. Leave out the verb and Testlane runs the project's `default_command`, `code` unless you set another. A verb slot that names one of your `[commands.*]` entries is short for `run <name>`, so `testlane my-project 42 dev` runs `dev`. The built-in verbs win over a command of the same name, and `doctor` warns about the overlap.

### Workspace verbs

These take a project and a ref, and open the workspace first if it isn't there yet:

| Verb              | What it does                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `checkout`        | Opens the workspace and prints its path. It runs `[setup]` only with `--setup`                    |
| `code`            | Opens the workspace in your editor, or the one you pass with `--editor`                           |
| `run <name>`      | Runs `[setup]`, then a command from your project file                                             |
| `exec -- <argv…>` | Runs `[setup]`, then any command you give it, without a shell                                     |
| `shell`           | Runs `[setup]`, then starts a shell in the workspace with its `TESTLANE_*` variables              |
| `sync`            | Fetches the ref again and resets the workspace to it                                              |
| `diff`            | Shows what the workspace changes, with `gh pr diff` for a PR when `gh` is there                   |
| `info`            | Prints the workspace's details                                                                    |
| `rm`              | Removes the workspace, after asking                                                               |
| `start <name>`    | Runs a command in the background and returns once `127.0.0.1:{port}` accepts connections          |
| `stop`            | Stops the process `start` left running                                                            |
| `logs [-f]`       | Prints that process's log, or follows it with `-f`                                                |

`run`, `exec`, `shell` and `start` take `--no-setup` to skip the install, `--reseed` to copy the seed files again and `--fetch` to fetch first. `run` and `start` also take `--env KEY=VALUE`, as often as you like, and `run` takes `--port <n>`:

```bash
testlane my-project 42 run dev --port 6000
testlane my-project 42 run test -- --watch        # --watch goes to the test command
testlane my-project 42 exec -- git log --oneline -2
```

`sync` won't reset a workspace with changes in it unless you say what to do with them: `--stash` keeps them in a stash and `--discard` throws them away. `--fresh` removes the workspace and opens it again, and it refuses to run while the workspace has changes:

```bash
testlane my-project 42 sync --stash
```

`start` lets you hand someone a running app and get your terminal back. It prints the URL once the port accepts a connection, waits up to `--timeout <seconds>` (300 by default) and exits with `6` if the server never comes up, so make sure your server listens on `127.0.0.1:$TESTLANE_PORT`. A workspace runs one such process at a time:

```bash
testlane my-project 42 start dev   # prints http://127.0.0.1:<port>
testlane my-project 42 logs -f     # follow the log until Ctrl-C
testlane my-project 42 stop
```

[Workspace verbs](https://testlane.dev/docs/cli/workspace-verbs) has every flag and the `--json` output of each verb.

### Project verbs

These take a project and no ref:

| Verb    | What it does                                                                                 |
| ------- | -------------------------------------------------------------------------------------------- |
| `list`  | Lists the project's workspaces, with each PR's state and checks when `gh` is there           |
| `clean` | Removes workspaces by slug or by filter, after showing its plan and asking                   |
| `ps`    | Lists the processes `start` left running in the project's workspaces, and their status       |

A bare `testlane my-project` runs `list`. In a terminal, it's a picker that prints the path of the workspace you choose, so `cd "$(testlane my-project)"` takes you there.

`clean` takes slugs or filters, not both. Its filters combine, so a workspace has to match each one you give:

```bash
testlane my-project clean pr-42              # one workspace, by its slug
testlane my-project clean --merged           # branches merged into the default branch
testlane my-project clean --closed           # PRs that closed or merged
testlane my-project clean --older-than 7d    # idle for a week (s, m, h, d or w)
```

It skips a workspace with changes unless you pass `--force`, and a working tree you adopted with a path unless you pass `--include-adopted`. [Project verbs](https://testlane.dev/docs/cli/project-verbs) covers `--all`, `--prune-state` and the rest.

### Top-level verbs

These take no project:

| Verb          | What it does                                                                         |
| ------------- | ------------------------------------------------------------------------------------ |
| `setup`       | Creates the config directory and writes your first project file                      |
| `projects`    | Lists the projects you've set up                                                     |
| `doctor`      | Checks git, `gh`, the config and state directories and every project                 |
| `config`      | Prints the config directory (`path`), edits, adds, validates or shows a project's config, and trusts a repository's `.testlane.toml` |
| `completions` | Prints a completion script for `bash`, `zsh` or `fish`                               |
| `mcp`         | Serves Testlane's tools to an MCP client over stdio                                  |
| `help`        | Prints the usage                                                                     |
| `version`     | Prints the version                                                                   |

`config` takes `path`, `edit [project]`, `add [project]`, `add <url>`, `validate [project]`, `show <project>` or `trust <project>`. `add` and `edit` both write a starter file when the project has none, while `add <url>` names the project after the repository, clones it and asks you to trust its `.testlane.toml`. `show` prints the config a run would use, with where each key came from, and `trust` shows the repository's file and records your approval. To turn on completions in bash or fish, add the line for your shell to its startup file:

```bash
eval "$(testlane completions bash)"   # ~/.bashrc
testlane completions fish | source    # ~/.config/fish/config.fish
```

zsh loads completion functions from the directories on its `fpath`, so write the script to a file once, then add that directory in `~/.zshrc` before `compinit` runs:

```bash
mkdir -p ~/.zsh/completions
testlane completions zsh > ~/.zsh/completions/_testlane
# then in ~/.zshrc:
fpath=(~/.zsh/completions $fpath)
autoload -Uz compinit && compinit
```

[Top-level verbs](https://testlane.dev/docs/cli/top-level-verbs) has each prompt and flag of `setup`, and every check `doctor` runs.

## Global flags

These work with every command, before or after the verb:

| Flag                               | What it does                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| `--config-dir <dir>`               | Reads the config from `<dir>` instead of `$TESTLANE_CONFIG_DIR` or `~/.testlane`                |
| `--pr`, `--branch`, `--path <v>`   | Reads the ref as a PR, a branch or a path, whatever it looks like. Only one goes with a command |
| `--dry-run`                        | Prints what would run and changes nothing                                                       |
| `--json`                           | Prints JSON on stdout, from `checkout`, `list`, `info`, `start`, `ps`, `projects` and `doctor`  |
| `-q`, `--quiet`                    | Leaves out the step lines on stderr. Warnings still print                                       |
| `-v`, `--verbose`                  | Prints each command Testlane runs, and the stack trace when a command fails                     |
| `-y`, `--yes`                      | Answers yes to every prompt                                                                     |
| `--no-color`                       | Turns off ANSI colours                                                                          |

`--dry-run` is the safest way to see what a command will do. For `run`, `exec` and `shell` it prints the environment as `export` lines, then the command:

```bash
testlane my-project 42 run dev --dry-run
```

[Global flags](https://testlane.dev/docs/cli/global-flags) has an example of each.

## Configuration

Testlane reads one TOML file per project from its config directory. It looks for the directory in `--config-dir` first, then `$TESTLANE_CONFIG_DIR`, then `~/.testlane`:

```
~/.testlane/
  defaults.toml        # optional: root, editor and default_command for every project
  my-project.toml      # one file per project, named after it
  seeds/
    my-project/        # files copied into each of the project's workspaces
      .env.local
```

A project name matches `^[a-z0-9][a-z0-9._-]*$`, and `defaults` and `seeds` are taken. `defaults.toml` holds `root`, the base directory for every project's clone and workspaces, with `editor` and `default_command` as fallbacks. It takes no `env` or `commands`, since those belong to one project: in its project file, or in its repository's `.testlane.toml`.

A project file needs only `repo`. These are the keys it takes:

| Key                                | What it's for                                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| `repo`                             | The repository's URL, over SSH or HTTPS. Required                                              |
| `repo_path`, `worktrees_path`      | Where the clone and the workspaces live, `{root}/<project>/repo` and `{root}/<project>/trees` by default |
| `default_branch`                   | The branch `diff` and `clean --merged` compare against. Set it, since without it `diff` shows only uncommitted changes and `clean --merged` assumes `main` |
| `editor`                           | An editor preset, or a command with `{path}` in it. `code` by default                          |
| `default_command`                  | What runs when you leave out the verb. `code` by default                                       |
| `ports`, `base_port`               | How many ports each workspace gets, from 1 to 10, and where the project's ports start          |
| `[setup]`                          | `run` installs dependencies, again only when the files in `cache_key` change. `seed_files` and `seed_from` copy files in |
| `[env]`                            | Variables for every command and hook, with template variables in their values                  |
| `[commands.<name>]`                | A command with its `run`, and an optional `cwd` and `env`                                      |
| `[hooks]`                          | Commands to run at `post_checkout`, `pre_run`, `post_sync` and `pre_clean`                     |

`config validate` checks every file and reports all the problems in a file at once, so you can fix them in one go.

### Repository config

A repository can commit a `.testlane.toml` at its root, so its maintainers write the setup, env and commands once and everyone who adds the project gets them. It takes `ports`, `default_command`, `setup.run`, `setup.cache_key`, `setup.seed_files`, `[env]`, `[commands]` and `[hooks]`. The keys about your machine, like `repo_path` or `editor`, stay in your project file, and Testlane rejects them in the repository's file.

Testlane reads the file only from the tip of the default branch, never from the branch or pull request you check out, so a pull request, even one from a fork, can't change what runs on your machine. It runs the file's commands only after you approve that exact content: the first time, it prints what the file would run and the whole file, and after a change, the diff. With no terminal to ask on, a command stops with exit `3` and the hint `testlane config trust my-project`, and `--yes` approves without asking. Until you approve, your project file works on its own.

Your project file wins wherever both set a key. `[env]` merges by key, `[commands]` by name and `[hooks]` by hook name, and a command of yours replaces the repository's command of that name whole. `testlane config show my-project` prints the merged config with where each key came from, and a repository with no `.testlane.toml` works exactly as before. [Ship a config with your repo](https://testlane.dev/docs/guides/ship-a-config-with-your-repo) walks through it from both sides.

### Template variables

`[env]` values, a command's `run` and `cwd`, hooks and editor commands can take these variables, in braces. Write `{{` for a literal `{`:

| Variable      | Value                                                                              |
| ------------- | ---------------------------------------------------------------------------------- |
| `{path}`      | The workspace's absolute path                                                      |
| `{repo_path}` | The absolute path of the project's clone                                           |
| `{data_dir}`  | The workspace's data directory                                                     |
| `{project}`   | The project's name                                                                 |
| `{ref}`       | The workspace's ref, like `feat/login`, `42` or a commit SHA                       |
| `{branch}`    | The workspace's branch, like `feat/login` or `pr/42`, or its slug when it has none |
| `{slug}`      | The workspace's slug, like `feat-login` or `pr-42`                                 |
| `{port}`      | The workspace's first port                                                         |
| `{port+N}`    | Its port `N`, for `N` below `ports`, like `{port+1}`                               |

Testlane also exports each value to every command it runs, whether your config uses it or not, as `TESTLANE_PATH`, `TESTLANE_REPO_PATH`, `TESTLANE_DATA_DIR`, `TESTLANE_PROJECT`, `TESTLANE_REF`, `TESTLANE_BRANCH`, `TESTLANE_SLUG`, `TESTLANE_PORT` and `TESTLANE_PORT_1` up to `TESTLANE_PORT_{ports-1}`.

`editor` takes one of these presets: `zed`, `code`, `cursor`, `windsurf`, `idea`, `webstorm`, `phpstorm`, `goland`, `vim`, `nvim`, `helix`, `hx` or `terminal`. Or it takes a command with `{path}` in it, like `emacsclient -n {path}`, and a command that ends in `:wait` keeps Testlane in the foreground until the editor exits.

[Configuration](https://testlane.dev/docs/configuration/overview) on the site goes through every key, with [Project file](https://testlane.dev/docs/configuration/project-file), [Environment and templates](https://testlane.dev/docs/configuration/environment-and-templates) and [Editors](https://testlane.dev/docs/configuration/editors).

## Upgrading from uxd

Testlane is the new name of uxd, and 2.0.0 is its first release under that name. Your projects, workspaces and running processes carry over, because Testlane 2.x still reads everything uxd wrote. Each time it falls back to an old name, it prints one warning on stderr with the fix, so you can move at your own pace, and `--json` output stays valid. Testlane 3.0 drops these fallbacks.

Here's how to move over:

1. Swap the package. The two commands have different names, so you can keep `uxd` installed until you're done:

   ```bash
   npm i -g @uxfront/testlane
   npm rm -g @uxfront/uxd       # once nothing calls uxd any more
   ```

2. Call `testlane` wherever you called `uxd`, like scripts, shell aliases and agent instructions. There's no `uxd` alias, since it would clash with an installed `@uxfront/uxd`.
3. Regenerate your shell completions, because the old script completes `uxd`. Remove the `uxd completions` line or file, then set up Testlane's as [Install Shell Completions](https://testlane.dev/docs/guides/shell-completions) shows: a line in your startup file for bash or fish, and a `_testlane` file on your `fpath` for zsh.
4. Move the config directory and the state directory while no `uxd` or `testlane` command is running. Your clones and workspaces stay where they are, because each project file names their paths:

   ```bash
   mv ~/.uxd ~/.testlane
   mv "${XDG_STATE_HOME:-$HOME/.local/state}/uxd" "${XDG_STATE_HOME:-$HOME/.local/state}/testlane"
   ```

5. Rename the variables you set, `UXD_CONFIG_DIR` to `TESTLANE_CONFIG_DIR` and `UXD_DEBUG` to `TESTLANE_DEBUG`, and the ones your dev servers, hooks and `[env]` values read, like `$UXD_PORT` to `$TESTLANE_PORT`.

This is what Testlane 2.x does with each old name:

| uxd 1.x                                   | Testlane 2.x                                           | What 2.x does with the old name                                              |
| ----------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `uxd`                                     | `testlane`                                             | Nothing. Scripts that call `uxd` need updating                               |
| `~/.uxd`                                  | `~/.testlane`                                          | Reads it when `~/.testlane` doesn't exist, and warns                         |
| `${XDG_STATE_HOME:-~/.local/state}/uxd`   | `${XDG_STATE_HOME:-~/.local/state}/testlane`           | Reads and writes it when the new directory doesn't exist, and warns          |
| `$UXD_CONFIG_DIR`                         | `$TESTLANE_CONFIG_DIR`                                 | Reads it when `--config-dir` and `$TESTLANE_CONFIG_DIR` aren't set, and warns |
| `UXD_DEBUG=1`                             | `TESTLANE_DEBUG=1`                                     | Turns on debug output when `$TESTLANE_DEBUG` isn't set, and warns            |
| `UXD_PATH`, `UXD_PORT`, `UXD_PORT_1`, …   | `TESTLANE_PATH`, `TESTLANE_PORT`, `TESTLANE_PORT_1`, … | Exports both names with the same value. Testlane can't see who reads them, so this one never warns |

When the old and the new name are both there, the new one wins and nothing warns. The project's `[env]`, a command's `env` and `--env` still win over both sets of exported variables.

If you're coming from an early 1.x, two more things changed along the way. 1.0.0 has no `setup` command and reports its version as `0.0.0`. 1.1.0 removed the `extends` key, and project files are validated strictly, so a file that still has an `extends` line fails every command that loads it until you delete that line. [`CHANGELOG.md`](CHANGELOG.md) lists what changed in each release.

## Exit codes

Every error prints one line on stderr, like `error(E_CONFIG): unknown project 'nope'`, with a `hint:` line after it when there's a fix to suggest. The exit code tells you which kind of error it was, so a script can branch on it rather than on the message:

| Code | Error        | What it means                                                                  |
| ---- | ------------ | ------------------------------------------------------------------------------ |
| `0`  |              | Success                                                                        |
| `1`  | `E_INTERNAL` | Something went wrong inside Testlane                                           |
| `2`  | `E_USAGE`    | A flag or an argument is wrong                                                 |
| `3`  | `E_CONFIG`   | The config is invalid, the project doesn't exist, or a repository's `.testlane.toml` needs your approval |
| `4`  | `E_RESOLVE`  | The ref couldn't be resolved                                                   |
| `5`  | `E_GIT`      | A git or `gh` command failed. Some of these print as `E_EXTERNAL`              |
| `6`  | `E_SETUP`    | `[setup]`, a hook that can block or `start` failed                             |

[Exit codes](https://testlane.dev/docs/cli/exit-codes) has examples of each error.

## Development

Testlane's CLI is TypeScript, compiled to `dist/`, and its tests run on Vitest. From a clone:

```bash
npm install
npm test                        # unit and integration tests
npm run typecheck               # tsc --noEmit
npm run build                   # writes dist/
node dist/bin/testlane.js help  # runs the CLI you built
```

[`DESIGN.md`](DESIGN.md) is the source of truth for how Testlane behaves and what it covers, and [`docs/adrs/`](docs/adrs/) holds the decisions behind it. The docs site lives in [`apps/docs`](apps/docs/), and its README says how to write a page.

Every change that reaches the published package needs a changeset, since the changesets become the release notes. Run `pnpm changeset` and commit the file it writes with your PR. [`.changeset/README.md`](.changeset/README.md) explains how to write one, and [`docs/release-runbook.md`](docs/release-runbook.md) how a release runs and how to roll one back.
