---
title: uxd
description: Turn any git ref into a running local workspace with one command.
seo:
  title: uxd — run any git ref locally in one command
  description: uxd turns a PR number, a branch, a commit, a URL, or a path into an isolated git worktree with dependencies installed, ports allocated, and a dev server up.
navigation: false
---

<!--
Hero ----------------------------------------------------------------------------------------------
-->

::gradient-page-hero
---
orientation: horizontal
ui:
  description: text-toned
---

::browser-frame
---
title: Terminal
---

```bash
uxd my-project 42 code
uxd my-project 42 run dev
uxd my-project clean --merged
```

::

#headline
unpack · execute · debug

#title
Any git ref, running locally in [one command]{.text-primary}

#description
uxd turns a PR number, a branch, a commit, a URL, or a path into an isolated git worktree — dependencies installed, ports allocated, dev server up.

#links
  :::u-button
  ---
  class: w-full justify-center sm:w-auto
  color: primary
  size: xl
  to: /docs/getting-started
  trailing-icon: i-lucide-arrow-right
  ---
  Get started
  :::

  :::u-button
  ---
  class: w-full justify-center sm:w-auto
  color: neutral
  icon: i-lucide-github
  size: xl
  target: _blank
  to: https://github.com/uxfront-com/uxd
  variant: outline
  ---
  Star on GitHub
  :::
::

<!--
Section 1 — The pipeline ---------------------------------------------------------------------------
-->

::u-page-section{class="border-t border-default"}
#title
Every command is the same three steps

#description
One pipeline behind every verb. Learn it once and the whole CLI is predictable.

#features
  :::u-page-feature
  ---
  as: li
  icon: i-lucide-git-branch
  ---
  #title
  [resolve]{.text-primary} the ref

  #description
  A PR number, a branch, a 40-char SHA, a URL, or a local path becomes one concrete git target. First match wins.
  :::

  :::u-page-feature
  ---
  as: li
  icon: i-lucide-folder-tree
  ---
  #title
  [materialize]{.text-primary} the workspace

  #description
  A worktree exists, with dependencies installed, seed files copied, ports allocated, and the environment computed. Idempotent — and cheap when it already exists.
  :::

  :::u-page-feature
  ---
  as: li
  icon: i-lucide-play
  ---
  #title
  [act]{.text-primary} on it

  #description
  Open an editor, run a configured command, exec, drop into a shell, diff, or sync. `checkout` is this pipeline with a no-op act step.
  :::
::

<!--
Section 2 — Refs -----------------------------------------------------------------------------------
-->

::u-page-section{class="border-t border-default" orientation="horizontal"}

::browser-frame
---
title: Six ways to name the same thing
---

```bash
uxd my-project 42            # pull request
uxd my-project feat/login    # branch
uxd my-project 1a2b3c…       # 40-char SHA
uxd my-project - shell       # last used ref
uxd …/pull/42 code           # straight from a URL
```

::

#title
Any ref [you can name]{.text-primary}

#description
If you can point at it, uxd can run it. No cloning, no stashing, no "let me finish what I'm doing first".

#features
  :::u-page-feature
  ---
  as: li
  icon: i-lucide-list-tree
  ---
  #title
  Six kinds of ref

  #description
  PR numbers, branches, SHAs, GitHub URLs, local paths, and `-` for the last ref you used.
  :::

  :::u-page-feature
  ---
  as: li
  icon: i-lucide-link
  ---
  #title
  Paste the URL

  #description
  A GitHub PR or tree URL carries the project and the ref, so one argument is the whole command.
  :::
::

<!--
Section 3 — Isolation ------------------------------------------------------------------------------
-->

::u-page-section{class="border-t border-default" orientation="horizontal" reverse}

::browser-frame
---
title: ~/.uxd/my-project.toml
---

```toml
ports = 2

[setup]
run = "pnpm install --frozen-lockfile"
cache_key = ["pnpm-lock.yaml"]
seed_files = [".env.local"]

[env]
PORT = "{port}"
API_PORT = "{port+1}"
```

::

#title
Isolated [by construction]{.text-primary}

#description
Three branches can run at once without fighting over a port, a node_modules, or a database file.

#features
  :::u-page-feature
  ---
  as: li
  icon: i-lucide-plug
  ---
  #title
  A port of its own

  #description
  uxd allocates a contiguous block of free ports per workspace. `ports = 2` gets you `{port}` and `{port+1}`, exported and templated into your commands.
  :::

  :::u-page-feature
  ---
  as: li
  icon: i-lucide-sprout
  ---
  #title
  Seed files land on their own

  #description
  `.env.local`, local certificates, scratch config — copied into every new worktree from your seeds directory, and never overwritten. [Seed local files](/docs/guides/seed-local-files).
  :::

  :::u-page-feature
  ---
  as: li
  icon: i-lucide-package-check
  ---
  #title
  Setup that remembers

  #description
  `cache_key` globs mean installs rerun only when the lockfile actually moves.
  :::
::

<!--
Section 4 — Environment ----------------------------------------------------------------------------
-->

::u-page-section{class="border-t border-default" orientation="horizontal"}

::browser-frame
---
title: uxd my-project feat/login run dev --dry-run
---

```bash
export UXD_PATH=~/dev/uxd/my-project/trees/feat-login
export UXD_REPO_PATH=~/dev/uxd/my-project/repo
export UXD_DATA_DIR=~/dev/uxd/my-project/trees/.data/feat-login
export UXD_PROJECT=my-project
export UXD_REF=feat/login
export UXD_BRANCH=feat/login
export UXD_SLUG=feat-login
export UXD_PORT=3053
export PORT=3053
bash -c 'pnpm dev "$@"' uxd
```

::

#title
Every command knows [where it is]{.text-primary}

#description
Paths, ports and your own variables are resolved before anything runs — and you can read the whole environment back before you commit to it.

#features
  :::u-page-feature
  ---
  as: li
  icon: i-lucide-variable
  ---
  #title
  `UXD_*` in every child process

  #description
  `run`, `exec`, `shell`, `[setup]` and hooks all receive `UXD_PATH`, `UXD_PORT`, `UXD_DATA_DIR`, `UXD_BRANCH` and the rest — whether your config mentions them or not.
  :::

  :::u-page-feature
  ---
  as: li
  icon: i-lucide-braces
  ---
  #title
  Template variables

  #description
  `{port}`, `{port+1}`, `{path}`, `{data_dir}`, `{branch}` and more interpolate into `[env]` values, commands, hooks and editor templates. [Template variables](/docs/configuration/environment-and-templates).
  :::

  :::u-page-feature
  ---
  as: li
  icon: i-lucide-layers
  ---
  #title
  Layered, and overridable

  #description
  Your `[env]` sits over the `UXD_*` block, a command's own `env` over that, and `--env K=V` wins on the command line.
  :::

  :::u-page-feature
  ---
  as: li
  icon: i-lucide-eye
  ---
  #title
  Read it before you run it

  #description
  `--dry-run` prints the resolved environment as `export` lines followed by the shell-quoted command. Nothing spawns.
  :::
::

<!--
Section 5 — Lifecycle ------------------------------------------------------------------------------
-->

::u-page-section{class="border-t border-default"}
#title
From open to [disposed]{.text-primary}

#description
A workspace has a lifespan. uxd covers all of it, then cleans up after itself.

#features
  :::u-page-feature
  ---
  as: li
  icon: i-lucide-terminal
  ---
  #title
  One verb per intent

  #description
  `code`, `run`, `shell`, `exec`, `diff`, `sync` — each materializes first, so there is no wrong order.
  :::

  :::u-page-feature
  ---
  as: li
  icon: i-lucide-layout-list
  ---
  #title
  See the whole board

  #description
  `list` shows every workspace with its branch, port, age, PR state and CI mark.
  :::

  :::u-page-feature
  ---
  as: li
  icon: i-lucide-refresh-cw
  ---
  #title
  Refresh without rebuilding

  #description
  `sync` resets a workspace to its ref — `--stash` or `--discard` for local changes, `--fresh` to re-materialize from scratch.
  :::

  :::u-page-feature
  ---
  as: li
  icon: i-lucide-webhook
  ---
  #title
  Your steps at every seam

  #description
  `post_checkout`, `pre_run`, `post_sync`, `pre_clean` — start a container, drop a scratch database, or veto a removal. [Commands & hooks](/docs/configuration/commands-and-hooks).
  :::

  :::u-page-feature
  ---
  as: li
  icon: i-lucide-trash-2
  ---
  #title
  Reclaim the disk

  #description
  `clean --merged`, `--closed`, `--older-than 7d`. Prints a plan, asks first, skips dirty trees.
  :::

  :::u-page-feature
  ---
  as: li
  icon: i-lucide-file-json
  ---
  #title
  Made to be scripted

  #description
  `--json` on `checkout`, `list`, `info` and `projects`, with progress on stderr — so `cd "$(uxd my-project 42)"` just works. [Script with uxd](/docs/guides/script-with-uxd).
  :::
::

<!--
Section 6 — Requirements ---------------------------------------------------------------------------
-->

::u-page-section{class="border-t border-default"}
#title
Runs on the stack [you already have]{.text-primary}

#description
No new runtime, no daemon, no account.

#features
  :::u-page-feature
  ---
  as: li
  icon: i-lucide-hexagon
  ---
  #title
  Stock Node, plain git

  #description
  Node ≥ 18 and git ≥ 2.38. Install it with npm, pnpm, or yarn — no Bun or Deno required.
  :::

  :::u-page-feature
  ---
  as: li
  icon: i-lucide-circle-dashed
  ---
  #title
  `gh` optional

  #description
  With it you get PR state, CI marks, and true PR diffs. Without it, every feature degrades gracefully.
  :::

  :::u-page-feature
  ---
  as: li
  icon: i-lucide-settings-2
  ---
  #title
  One TOML per project

  #description
  Commands, env, hooks, editor, ports — versioned as text, validated in aggregate by `config validate`.
  :::
::

<!--
Closing CTA ----------------------------------------------------------------------------------------
-->

::u-page-c-t-a
---
class: border-t border-default
variant: subtle
---
#title
Materialize your first workspace

#description
`uxd setup` creates the config dir, scaffolds your first project file, and prints the next command to run.

#links
  :::u-button
  ---
  class: w-full justify-center sm:w-auto
  color: primary
  size: xl
  to: /docs/getting-started
  trailing-icon: i-lucide-arrow-right
  ---
  Get started
  :::

  :::u-button
  ---
  class: w-full justify-center sm:w-auto
  color: neutral
  size: xl
  to: /docs/cli/overview
  variant: outline
  ---
  CLI reference
  :::
::
