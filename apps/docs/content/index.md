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
  to: /docs/uxd/getting-started/introduction
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
  A worktree exists, with dependencies installed, seed files copied, and ports allocated. Idempotent — and cheap when it already exists.
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
title: ~/.config/uxd/projects/acme-web.toml
---

```toml
[ports]
count = 1

[env]
PORT = "{port}"
```

::

#title
Isolated [by construction]{.text-primary}

#description
Three branches can run at once without fighting over a port or a node_modules.

#features
  :::u-page-feature
  ---
  as: li
  icon: i-lucide-plug
  ---
  #title
  A port of its own

  #description
  uxd allocates free ports, exported as `$UXD_PORT` and templated into your commands.
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
Section 4 — Lifecycle ------------------------------------------------------------------------------
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
  icon: i-lucide-trash-2
  ---
  #title
  Reclaim the disk

  #description
  `clean --merged`, `--closed`, `--older-than 7d`. Prints a plan, asks first, skips dirty trees.
  :::
::

<!--
Section 5 — Requirements ---------------------------------------------------------------------------
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
  to: /docs/uxd/getting-started/introduction
  trailing-icon: i-lucide-arrow-right
  ---
  Get started
  :::

  :::u-button
  ---
  class: w-full justify-center sm:w-auto
  color: neutral
  size: xl
  target: _blank
  to: https://github.com/uxfront-com/uxd#commands
  variant: outline
  ---
  CLI reference
  :::
::
