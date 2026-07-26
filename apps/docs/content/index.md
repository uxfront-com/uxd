---
title: uxd
description: Run any pull request or branch locally, without disturbing the work you already have open.
seo:
  title: uxd — run any pull request or branch locally, in one command
  description: Point uxd at a pull request, a branch, a commit or a link. You get the code checked out, dependencies installed and a port of your own, while everything you already had open stays untouched.
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
Point uxd at a pull request, a branch, or a link someone pasted in chat. You get the code checked out, dependencies installed, and a port of your own — while the work you already have open stays exactly where it is.

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
Learn it once and the whole tool is predictable. There is no special case to remember.

#features
  :::u-page-feature
  ---
  as: li
  icon: i-lucide-git-branch
  ---
  #title
  [resolve]{.text-primary} the ref

  #description
  You point at something — a pull request number, a branch, a commit, a link from chat. uxd works out what you meant.
  :::

  :::u-page-feature
  ---
  as: li
  icon: i-lucide-folder-tree
  ---
  #title
  [materialize]{.text-primary} the workspace

  #description
  A folder appears with the code checked out, dependencies installed, your local files copied in, and a free port reserved. Ask again and you get the same folder back straight away.
  :::

  :::u-page-feature
  ---
  as: li
  icon: i-lucide-play
  ---
  #title
  [act]{.text-primary} on it

  #description
  Open your editor, start the dev server, run a one-off command, or just print the path. Whatever you asked for, the workspace is ready before it runs.
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
  Pull request numbers, branch names, commit hashes, GitHub links, local paths — and a dash when you mean the one you were just on.
  :::

  :::u-page-feature
  ---
  as: li
  icon: i-lucide-link
  ---
  #title
  Paste the link

  #description
  A GitHub link already says which project and which pull request. Paste it in and that is the entire command.
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
Run three at once, [nothing collides]{.text-primary}

#description
Three branches can run at the same time without fighting over a port, a node_modules, or a database file.

#features
  :::u-page-feature
  ---
  as: li
  icon: i-lucide-plug
  ---
  #title
  A port of its own

  #description
  Every workspace gets its own free ports, and uxd hands them to your commands. Ask for two if your app needs an API alongside it.
  :::

  :::u-page-feature
  ---
  as: li
  icon: i-lucide-sprout
  ---
  #title
  The files git never sees

  #description
  Your local env file, a certificate, a scratch config — copied into every new workspace, and never written over one you already have. [How seeding works](/docs/guides/seed-local-files).
  :::

  :::u-page-feature
  ---
  as: li
  icon: i-lucide-package-check
  ---
  #title
  Setup that remembers

  #description
  Dependencies install on the first checkout and stay installed. uxd only runs them again when your lockfile actually changes.
  :::
::

<!--
Section 4 — Environment ----------------------------------------------------------------------------
-->

::u-page-section{class="border-t border-default"}
#title
Your commands know [where they are]{.text-primary}

#description
Paths, ports and your own variables are worked out before anything runs, so one command behaves correctly in every workspace.

#features
  :::u-page-feature
  ---
  as: li
  icon: i-lucide-variable
  ---
  #title
  The details, handed over

  #description
  Everything uxd runs for you — setup, hooks, your dev server, a shell — is told the workspace's path, ports, branch and data directory. Anything you set yourself sits on top and wins.
  :::

  :::u-page-feature
  ---
  as: li
  icon: i-lucide-braces
  ---
  #title
  Write it once, with placeholders

  #description
  Drop a placeholder for the port, the path or the branch into any command, environment value or hook, and uxd fills it in per workspace. [Template variables](/docs/configuration/environment-and-templates).
  :::

  :::u-page-feature
  ---
  as: li
  icon: i-lucide-eye
  ---
  #title
  See it before you run it

  #description
  A dry run prints the exact environment and the exact command, then stops. Useful on the day something behaves differently than you expected.
  :::
::

<!--
Section 5 — Lifecycle ------------------------------------------------------------------------------
-->

::u-page-section{class="border-t border-default"}
#title
From opened to [cleaned up]{.text-primary}

#description
A workspace has a lifespan. uxd covers all of it, and clears up after itself at the end.

#features
  :::u-page-feature
  ---
  as: li
  icon: i-lucide-terminal
  ---
  #title
  One word per intent

  #description
  Open an editor, start a server, get a shell, read the diff. Each one sets the workspace up first, so there is no wrong order to do things in.
  :::

  :::u-page-feature
  ---
  as: li
  icon: i-lucide-layout-list
  ---
  #title
  See the whole board

  #description
  One list of everything you have open — the branch, the port, how old it is, and whether its pull request is still alive.
  :::

  :::u-page-feature
  ---
  as: li
  icon: i-lucide-refresh-cw
  ---
  #title
  Catch up without starting over

  #description
  Pull a workspace back up to date with its branch. If you have uncommitted work, uxd stops and tells you, rather than quietly throwing it away.
  :::

  :::u-page-feature
  ---
  as: li
  icon: i-lucide-webhook
  ---
  #title
  Room for your own steps

  #description
  Start a container before the dev server, drop a scratch database on the way out, or block a removal that is not safe yet. [Commands and hooks](/docs/configuration/commands-and-hooks).
  :::

  :::u-page-feature
  ---
  as: li
  icon: i-lucide-trash-2
  ---
  #title
  Get the disk back

  #description
  Clear out the workspaces whose pull requests have merged or closed. uxd shows you the list, asks before deleting, and skips anything with uncommitted work in it.
  :::

  :::u-page-feature
  ---
  as: li
  icon: i-lucide-file-json
  ---
  #title
  Fine inside your own scripts

  #description
  The commands that produce data can print JSON instead, with progress kept out of the way — so you can wrap uxd without parsing around it. [Script with uxd](/docs/guides/script-with-uxd).
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
  Node 18 or newer and git 2.38 or newer. Install it with npm, pnpm or yarn — there is nothing else to add.
  :::

  :::u-page-feature
  ---
  as: li
  icon: i-lucide-circle-dashed
  ---
  #title
  GitHub's CLI, if you have it

  #description
  With it you get pull request status, CI results, and true pull request diffs. Without it, everything else still works.
  :::

  :::u-page-feature
  ---
  as: li
  icon: i-lucide-settings-2
  ---
  #title
  One small file per project

  #description
  Your commands, environment and hooks live in one readable text file, and uxd can check it for mistakes before you rely on it.
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
Try it on the next pull request you review

#description
One setup command writes your config, scaffolds your first project, and tells you exactly what to run next.

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
