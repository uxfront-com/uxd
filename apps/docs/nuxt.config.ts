import { useNuxt } from "@nuxt/kit";

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
	extends: ["@uxfront/layer-docs"],
	compatibilityDate: "2025-07-22",

	// Re-declare the layer's constants auto-import dir against this app's srcDir
	// so the local `app/constants/sections.ts` (DOCS_SECTIONS, findDocsSectionBySlug)
	// overrides the layer's neutral empty default. Without this the layer's own
	// constants win and `/docs/*` sections resolve to nothing.
	imports: {
		dirs: ["constants"],
	},

	// Single Tailwind entry. This app's `main.css` re-imports the layer's base so
	// the consumer's `@source` scan compiles in the same pass; the `modules:done`
	// hook below then drops the layer's own standalone `main.css` registration to
	// avoid a second Tailwind pass that would clobber responsive variants.
	css: ["./app/assets/css/main.css"],

	content: {
		build: {
			markdown: {
				highlight: {
					// The layer's shared Shiki language set has no `toml`, and uxd's
					// project config files are TOML. Nuxt merges layer arrays by
					// concatenation, so this appends rather than replaces.
					langs: ["toml"],

					// The layer configures `langs` but never `theme`, so Nuxt Content's
					// stock `material-theme-*` map was in force and every Shiki token
					// failed WCAG 1.4.3 on this page — measured 2.18:1 (arguments),
					// 2.38:1 (command), 2.48:1 (comments), 2.57:1 (punctuation),
					// 2.77:1 (numbers) in light mode, and 3.04:1 on comments in dark.
					//
					// All THREE keys are restated. Nuxt Content's default map has a
					// `light` entry, and Shiki emits `html .light .shiki span { color:
					// var(--shiki-light) }` — higher specificity than the `--shiki-default`
					// fallback rule. Overriding only `default`/`dark` therefore leaves
					// light mode rendering the old palette, since `defu` keeps the
					// un-overridden `light` key.
					//
					// The high-contrast GitHub pair is used rather than plain
					// `github-light`/`github-dark`: the standard pair puts comments at
					// 4.61:1 on `bg-muted` in light and 3.03:1 in dark, so dark still
					// failed and light had 2% of headroom.
					theme: {
						default: "github-light-high-contrast",
						light: "github-light-high-contrast",
						dark: "github-dark-high-contrast",
					},
				},
			},
		},
	},

	site: {
		url: "https://docs.uxfront.com",
		name: "uxfront — Documentation",
	},

	routeRules: {
		"/docs": {
			redirect: "/docs/getting-started",
		},
	},

	nitro: {
		prerender: {
			// The layer seeds "/"; make sure the docs entry point is baked too.
			routes: ["/docs/getting-started"],
		},
	},

	hooks: {
		"modules:done": () => {
			const nuxt = useNuxt();
			nuxt.options.css = nuxt.options.css.filter(
				(entry) =>
					typeof entry !== "string" || !entry.includes("@uxfront/layer-docs"),
			);
		},
	},
});
