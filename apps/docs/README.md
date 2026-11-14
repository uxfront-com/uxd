# @uxfront/docs

The Nuxt site for https://testlane.dev: the homepage and the documentation at `/docs`, with every page prerendered. Production is the static build that Cloudflare Workers serves, and the Nitro server build serves the other hosts (see [Deploying](#deploying)). It's built like [uxfront.com](https://github.com/uxfront-com/uxfront/tree/main/apps/web), [opencomponents.dev](https://github.com/uxfront-com/open-components) and [unframework.dev](https://github.com/uxfront-com/unframework/tree/main/apps/web), from the same homepage kit, with the docs on [Docus](https://docus.dev).

## Commands

Run them from the repository root, since the site shares its lockfile with the workspace:

```bash
pnpm install --filter @uxfront/docs
pnpm --filter @uxfront/docs dev         # dev server on http://localhost:3000
pnpm --filter @uxfront/docs test        # the redirects, the homepage's samples and the lanes formation
pnpm --filter @uxfront/docs build       # nuxt build → .output, every page prerendered into .output/public
pnpm --filter @uxfront/docs lighthouse  # Lighthouse CI against .output/public, fails below 0.95 in any category
```

The build prerenders by crawling links from `/` and the introduction, and fails on any page that doesn't render, so a broken link or a renamed page fails it too.

## The homepage

The page (`app/pages/index.vue`) holds the copy and the scene. Its story follows `lanes`, a formation of this site's own: one stream of white light (the repository) that four refs branch off, each into a lane of its own that ends in a lit workspace with its port.

| Section         | Formation                                                                               | Copy                                                  |
| --------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Hero            | `lanes`, held with all four workspaces lit, a ref and its port beside each              | What Testlane does                                    |
| 01 Pipeline     | `lanes` seen from the left, beside the copy                                             | The three steps every command takes                   |
| 02 Refs         | `outline`: the particles gather around the code panel                                   | The kinds of ref you can point at                     |
| 03 Isolation    | Close-up on the workspaces, the lanes faint behind the copy, a ref and port on each     | Why workspaces don't collide                          |
| 04 Environment  | `outline`, around the project file                                                      | What Testlane tells your commands                     |
| 05 Lifecycle    | `lanes` from below, dimmed behind the six details                                       | From opening a workspace to cleaning it up            |
| 06 Requirements | Close-up on the repository's stream, the rest dimmed                                    | What Testlane needs                                   |
| Finale          | The light corridor                                                                      | The docs, the CLI reference, GitHub and the other UXFront projects |

The chapters wrap `lanes` in two ways: `hold()` from `@uxfront/scene` keeps it at a fixed progress (the lanes branch off one after another as a chapter is read, so held, all four stay lit while the page starts to scroll), and `spotlight()` in `app/lib/formations/spotlight.ts` lights one stretch of it along the x axis.

`lanes` lives in `app/lib/formations/`:

- `lanes.ts` describes it with `defineFormation()`: its framings for desktop and mobile, and its anchors, `lanes:0` to `lanes:3`, at each workspace's port, top to bottom. The page pins a ref and its port there.
- `lanes.shader.ts` is its GLSL, which the scene imports once the page is idle, so it's a chunk of its own that the homepage never preloads. It needs no `setup()` or `update()`, so nothing reads the page's layout while it draws.
- `lanes.geometry.ts` holds the shape both of them use, so the labels sit where the workspaces are drawn. Keep the GLSL in step with it.

Everything else comes from the homepage kit:

- [`@uxfront/layer-ui`](https://www.npmjs.com/package/@uxfront/layer-ui), extended in `nuxt.config.ts`: auto-imports the components, self-hosts the fonts, adds `useUxHead()` and keeps the critical path clean.
- [`@uxfront/ui`](https://www.npmjs.com/package/@uxfront/ui): the Vue components (`UxSite`, `UxHero`, `UxChapter`, `UxSplit`, `UxFinale`, the HUD, the header and the labels pinned to the formations) and the design tokens.
- [`@uxfront/scene`](https://www.npmjs.com/package/@uxfront/scene): the WebGL particle scene and the `outline` and `corridor` formations. Without WebGL2, the page shows the scene's fallback with all of its copy.

The refs, the project file and the workspace labels the page shows live in `app/data/samples.ts`. `test/samples.test.ts` parses every ref with the CLI's own `parseRef`, so a sample can't promise what `testlane` doesn't do, like a short SHA read as a commit. It also keeps each line of the code samples to 30 characters, which fit the code panel on a 320px phone.

`public/og.jpg` is a 1200 × 630 capture of the hero, with the HUD and the scroll cue hidden. Capture it again when the hero changes. The favicons in `public/` draw the same lanes.

## The docs

The documentation is built with Docus, through [`@uxfront/layer-docs`](https://www.npmjs.com/package/@uxfront/layer-docs), the second layer in `nuxt.config.ts`. Pages are markdown files in `content/docs/`, served under `/docs`. Number files and folders to order them in the sidebar, as in `1.getting-started/1.introduction.md`, which is served at `/docs/getting-started/introduction`. From those files, Docus builds the sidebar, search, table of contents, a markdown copy of each page at `/raw/<path>.md`, `llms.txt`, `llms-full.txt`, `sitemap.xml` and each page's Open Graph image.

How it shares the app with the homepage:

- `app/app.vue` replaces Docus's own, so it renders the Docus shell (header, sidebar, search), loaded lazily, on `/docs` and below, and the bare page everywhere else. `app/error.vue` renders `UxErrorPage`, docs included.
- `docsTheme.byline` in `app/app.config.ts` signs the docs header's "Testlane" "by UXFront", like the homepage header, and `docsTheme.headerLinks` adds the Docs and GitHub links.
- Docus adds Tailwind CSS and Nuxt UI to the entry stylesheet. On the homepage, `@uxfront/layer-ui` loads that stylesheet after first paint, and the `.ux-site` styles take precedence over it. Keep `app/app.css`, which Docus imports into the same stylesheet, off `.ux-site` too.
- `app/app.config.ts` sets the theme colours and the GitHub, "Edit this page" and "Report an issue" links, with `rootDir: "apps/docs"`, since the docs don't live at the repository root.
- Docus reads the site URL from `NUXT_SITE_URL`, which `nuxt.config.ts` defaults to the production origin.
- Docus's MCP server is off (`mcp.enabled` in `nuxt.config.ts`), and so is its AI assistant, which only starts with an `AI_GATEWAY_API_KEY`.
- `server/routes/sitemap.xml.ts` replaces Docus's `/sitemap.xml` route, as on unframework.dev. Docus's lists a landing page from `content/index.md`, which this site doesn't have, so it left the homepage out. This one lists `/` first, then the docs pages.
- In content, link to the generated files (`/llms.txt`, `/raw/…`) with `{external}`. Otherwise the router handles the click and shows the 404 page.

### Writing the docs

We write these pages the way the Open Components docs are written, so someone who knows one site finds their way around the other. The rules come from `## Writing the docs` and `## Markdown conventions` in [Open Components' `AGENTS.md`](https://github.com/uxfront-com/open-components/blob/main/AGENTS.md), and this section says where Testlane does things its own way. The Getting started pages follow every rule here, so read one before you write a page of your own.

#### Pick an outline

Every page takes one of four outlines, so readers find the same thing in the same place wherever they land. Pick the one that matches what the reader came to do:

- **Concept page.** It explains an idea the commands rest on, like Introduction, How It Works, Refs and Workspaces, or the Overview in Configuration.
- **Guide.** It walks the reader from a starting point to a working result, like Installation, Quick Start and every page in Guides.
- **Reference page.** It lists every verb or key in one place, like every page in CLI and the pages after the Overview in Configuration.
- **README.** The repository's `README.md` is also the package's page on npm, so it gives a first-time reader what they need in the order below and leaves the depth to this site.

A **concept page** opens with what the idea lets the reader do, then what the page covers, either as one bold lead-in per section or as a `::card-group` of links. The Introduction also names three things that go wrong without Testlane, after "Think of…", the way the Open Components Button page does:

```md
---
title: <Title Case, with "and" rather than "&">
description: <one sentence, starting from what the reader gets>
navigation:
  icon: <the page's icon>
seo:
  title: <the title>
  description: <a sentence or two in the same voice>
---

<What it lets people do, starting from them.>

This page covers:

- **<Section>:** <what it covers>.

## At a glance        (an Aspect table of the facts a reader may come for, like "Where it lives" or "Default")
## <Sections>         (the first opens "Let's start with…", then "Now let's look at…", "Next, let's look at…" and "Finally, let's look at…")
## FAQ                (optional: an ::accordion, each label the question and each answer starting with the answer)
## Sources            (only when the page relies on outside material, like git's worktree docs)
## Where to go next   (optional, last: links to the pages a reader wants after this one)
```

A **guide** says in its opening what the reader will have at the end, and why they'd want it. Its walkthrough is a `::steps{level="3"}` block with one action per step, the command in a block of its own and a sentence on what the reader should see. Troubleshooting is the one guide that's a set of questions instead: it starts with `doctor`, then groups its `::accordion`s under `## Errors by code` and `## Common situations`, with the error or the symptom as each label.

```md
<frontmatter, as on a concept page>

<What the reader will have at the end, and why they'd want it.>

## Before you start          (optional: what they need, as a list)
## <Title of the walkthrough> (a ::steps{level="3"} block)
## <Deeper sections>          (variations and details, each opening with what it's for)
## FAQ                        (optional, as on a concept page)
## Where to go next           (always last: the reference pages and related guides)
```

A **reference page** opens with what its verbs or keys let the reader do, and when they'd reach for them. Then each verb or key group gets a section of its own, in the order of the At a glance table. Keep a verb's usage in backticks in its heading, like `` ## `start <name>` ``, since other pages link to its anchor:

```md
<frontmatter, as on a concept page>

<What these verbs or keys let the reader do.>

## At a glance               (one table of everything on the page: verb, what it does, takes --json; or key, type, default, what it's for)
## `<verb>` or <key group>   (one sentence on what it's for, the usage in a code block, a Flag | What it does | Default table,
                              one example and what it prints, then its --json fields and exit codes where they apply)
## FAQ                       (optional, as on a concept page)
```

The **README** runs in this order, with the depth left to this site so it stays at 450 lines or fewer:

- `# Testlane`, then an opening paragraph with no heading above it and a link to `testlane.dev`.
- `## Install`, with the requirements, the global install, the install from a clone and running it without installing.
- `## Usage`, the smallest session that works, from `setup` to a running workspace.
- `## Commands`, with `### Workspace verbs`, `### Project verbs` and `### Top-level verbs`, each a `Verb | What it does` table followed by the few examples that matter.
- `## Global flags`, a table.
- `## Configuration`, then `## Upgrading from uxd`.
- `## Exit codes`, a table.
- `## Development`.

Each section ends with a link to its page here.

#### Write in the docs' voice

These follow the Open Components rules. Testlane does three things its own way, and the lines marked **Testlane** say which:

- **Talk to the reader.** Write "you" for the reader and "we" for the project, give the reason in the same sentence as the rule, and write "we recommend" for anything that isn't a hard rule. Use contractions, British spelling and no serial comma.
- **Leave out hype and filler.** Words like `simply`, `just`, `easily`, `ensure`, `leverage`, `robust`, `powerful` and `seamless` make a claim sound bigger and say less. Leave out dashes, semicolons and exclamation marks in prose too, since a comma, a colon or a new sentence does the job. Write "like" or "for example" rather than `e.g.`, `i.e.` or `etc.`
- **Keep the names from the code.** **Testlane:** "Materialize" is the name of the pipeline's second step in `src/cli/help.ts` and `DESIGN.md`, so it keeps its spelling, as do `color` in `--no-color` and every other name a reader could type.
- **Write notes as prose.** **Testlane:** Open Components avoids Nuxt UI's callouts, since their text fails contrast there, while ours pass (see [Keeping it accessible](#keeping-it-accessible)), so we keep two. `::note` and `::tip` become a sentence that starts "Note that…" or "Keep in mind that…", as on the Open Components pages. Keep `::warning` and `::caution` for a command that deletes work, like `rm` and `clean`, or `sync` on a tree with changes.
- **Keep headings plain.** Write them in sentence case, as plain text and inline code, with no links, emphasis or dashes. A heading that gives guidance is an imperative, and an FAQ label is the question itself.
- **Link by absolute path.** Link within the docs by path, anchors included, like `/docs/cli/exit-codes`. Keep any heading another page links to, like `## Known caveats`, since renaming it breaks that link. **Testlane:** link to a generated file, like `/llms.txt`, with `{external}`, where Open Components writes `{external=""}`.
- **Check every fact.** Every verb, flag, exit code, config key, template variable, `TESTLANE_*` variable and `--json` field matches `src/` and `DESIGN.md`. Run every example that's safe to run, and show the output it really prints, with `/home/you` in place of your home directory.

#### Check a page before you hand it over

Before a page goes into review, check it against these rules, since a reviewer will:

- **Its format.** It has a `title` without "&" and a `description`, and opens with a paragraph rather than a heading, list or table. Its headings hold no links, emphasis or dashes, it has no `::note` or `::tip`, and it links by absolute path. A concept or reference page has `## At a glance`, a guide has a `::steps` block and ends on `## Where to go next`, and an FAQ is an `::accordion`.
- **Its voice.** Its prose, outside code, has none of the words and punctuation above, and no US spelling like `behavior` or `color`.
- **Its facts.** Every flag, `TESTLANE_*` variable, `E_*` code and TOML key it names exists in `src/`.
- **Its verbs.** Every verb in `src/cli/help.ts` has a heading in the CLI pages and a row in the README's verb tables.
- **Its links.** Every link to an anchor, on the same page or another, names a heading that's there.

### Keeping it accessible

Every page passes axe's contrast rule in light and dark mode, and the homepage and the docs pages we've measured score 1 in Lighthouse accessibility. Docus doesn't as it ships, so the site changes these:

- **Colours.** `app/app.css` darkens Nuxt UI's light-mode primary to the 700 shade, since green's default 500 fails AA contrast on white. `ui.prose.callout` in `app/app.config.ts` draws the callouts' text, links and inline code (`::note`, `::tip`, `::warning`, `::caution`) in the 800 shade in light mode, since Nuxt UI's 600 fails on their tinted background, `::warning`'s yellow worst at 2.75:1.
- **Links.** `ui.prose.a` underlines links at rest, so a link in a sentence doesn't stand out by colour alone.
- **Code.** `nuxt.config.ts` highlights code with the high-contrast GitHub themes, since the default themes put comments below 4.5:1.
- **Three Docus components.** `app/components/docs/DocsPageHeaderLinks.vue` names the button that opens the page menu, which only shows an arrow, and leaves out the menu's MCP items. `app/components/IconMenuToggle.vue` names the button that opens the header's menu on phones, and says whether it's open. `app/pages/[[lang]]/[...slug].vue` makes the separator above "Edit this page" decorative, since a separator can't hold links. The first and last are copies of Docus 5.13.0's, and the toggle draws the same lines, so keep all three in step when you upgrade Docus.

### Old URLs

Until 2.0 the docs lived one level deeper, under a prefix with the CLI's old name. `redirects.ts` sends every old URL to its page with a permanent 301, and `nuxt.config.ts` turns it into route rules: `/docs` and the group roots go to their first page, the old prefix forwards the rest of the URL to `/docs/**`, and the old scripting guide goes to `/docs/guides/script-with-testlane`. `test/redirects.test.ts` checks that every target is a page in `content/docs/`, so moving or renaming a page fails the test until its redirects follow.

## Deploying

The site deploys to Cloudflare Workers through Workers Builds, on the Worker `testlane`. A merge to `main` deploys `testlane.dev`, and every other branch gets a preview of its own.

Workers Builds reads these settings from the Cloudflare dashboard, under the Worker's Settings > Build:

| Setting                      | Value                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------- |
| Root directory               | `/`                                                                               |
| Build command                | `NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @uxfront/docs run generate` |
| Deploy command               | `npx wrangler deploy`                                                             |
| Non-production branch builds | on, with the default deploy command (`npx wrangler versions upload`)              |
| Build variables              | none                                                                              |
| Custom domain                | `testlane.dev`                                                                    |

Here's how the pieces fit:

- **The build is static.** Workers Builds sets `WORKERS_CI`, and `nuxt.config.ts` then defaults `NITRO_PRESET` to `cloudflare_pages_static`. `nuxt generate` prerenders every page into `apps/docs/dist`, with `_headers`, `_redirects`, `404.html` and the content database dumps that the pages query in the browser. Set `NITRO_PRESET` yourself to build another preset there.
- **`wrangler.jsonc` sits at the repository root**, because the deploy command runs from the root. It serves `apps/docs/dist` as static assets, with no Worker script, and answers unknown paths with the 404 page. Wrangler's `versions upload` stops without its `previews` block, so the block stays, even though it's empty.
- **`modules/workers-redirects.ts` rewrites `_redirects` after the build**, because Nitro writes two rules that Workers handle wrongly. It removes the `/* /404.html 404` rule, which Workers reject, failing the whole upload. It also turns a target like `/docs/uxd/cli/**` into `/docs/uxd/cli/:splat`, since Workers read `**` as part of the path and forward the matched part only through `:splat`. Its test is `test/workers-redirects.test.ts`.

A static site has no server, so one feature of the server build doesn't run on Cloudflare: the layer's redirect from `/` to `/llms.txt` for `curl` and for requests that accept `text/markdown`.

To try the Cloudflare build locally, build it and serve it with Wrangler from the repository root:

```sh
WORKERS_CI=1 NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @uxfront/docs run generate
npx wrangler dev
```

Keep in mind that `wrangler dev` only serves your machine. Never run `wrangler deploy` or `wrangler versions upload` by hand, since each one changes the live Worker.

### Other hosts

Every build without `WORKERS_CI` keeps Nitro's server output, `.output/server/index.mjs`, so these still work:

- **Vercel** builds with `vercel.json`.
- **Docker** builds with `Dockerfile`, from the repository root.
- **Nixpacks** builds with `nixpacks.toml`, from the repository root, with `NIXPACKS_CONFIG_FILE=apps/docs/nixpacks.toml`.

The prerenderer needs more memory than Node's default, so the builds set `NODE_OPTIONS=--max-old-space-size=4096`.

The server needs Node 22.13 or newer, both to build and to run: Docus reads its content with Node's built-in `node:sqlite`, which older versions don't have or keep behind a flag. `engines` in `package.json` says so, which Nixpacks and Vercel read to pick their Node version, and the `Dockerfile` uses `node:22-slim`, which is newer.
