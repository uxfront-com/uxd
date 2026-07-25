import { useNuxt } from "@nuxt/kit";
import {
	DOCS_SECTION_ENTRY_PATHS,
	DOCS_SECTIONS,
} from "./app/constants/sections";

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

	// Section roots carry no page of their own — the sidebar is built from the
	// children of `/docs/<slug>`, so an `index.md` there would be invisible in
	// the nav. `/docs` and every section root therefore redirect to that
	// section's first page.
	routeRules: {
		"/docs": { redirect: DOCS_SECTION_ENTRY_PATHS["getting-started"] },
		...Object.fromEntries(
			DOCS_SECTIONS.map((section) => [
				`/docs/${section.slug}`,
				{ redirect: DOCS_SECTION_ENTRY_PATHS[section.slug] },
			]),
		),
	},

	nitro: {
		prerender: {
			// The layer seeds "/"; make sure each section's entry page is baked too.
			routes: Object.values(DOCS_SECTION_ENTRY_PATHS),
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
