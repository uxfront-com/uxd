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
