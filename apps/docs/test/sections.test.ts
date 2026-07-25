import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DOCS_SECTIONS,
	DOCS_SECTION_ENTRY_PATHS,
	DOCS_SECTION_SLUGS,
	findDocsSectionBySlug,
} from "../app/constants/sections";

const contentRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../content/docs",
);

describe("docs sections", () => {
	it("exposes the four documentation sections", () => {
		expect(DOCS_SECTION_SLUGS).toEqual([
			"getting-started",
			"guides",
			"cli",
			"configuration",
		]);
	});

	it("resolves a section by slug", () => {
		expect(findDocsSectionBySlug("getting-started")?.key).toBe(
			"gettingStarted",
		);
		expect(findDocsSectionBySlug("missing")).toBeUndefined();
	});

	it("uses unique keys and folders", () => {
		const keys = DOCS_SECTIONS.map((section) => section.key);
		const folders = DOCS_SECTIONS.map((section) => section.folder);
		expect(new Set(keys).size).toBe(keys.length);
		expect(new Set(folders).size).toBe(folders.length);
	});

	it("backs every section with a content folder", () => {
		for (const section of DOCS_SECTIONS) {
			expect(existsSync(resolve(contentRoot, section.folder))).toBe(true);
		}
	});

	it("points each entry path at a page that exists", () => {
		for (const section of DOCS_SECTIONS) {
			const entry = DOCS_SECTION_ENTRY_PATHS[section.slug];
			expect(entry.startsWith(`/docs/${section.slug}/`)).toBe(true);

			// `01.introduction.md` → `/docs/getting-started/introduction`
			const page = entry.slice(`/docs/${section.slug}/`.length);
			const files = readdirSync(resolve(contentRoot, section.folder));
			expect(files.map((file) => file.replace(/^\d+\.|\.md$/g, ""))).toContain(
				page,
			);
		}
	});
});
