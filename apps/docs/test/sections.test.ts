import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DOCS_GROUP_ENTRY_PATHS,
	DOCS_GROUP_FOLDERS,
	DOCS_SECTIONS,
	DOCS_SECTION_ENTRY_PATHS,
	DOCS_SECTION_SLUGS,
	findDocsSectionBySlug,
} from "../app/constants/sections";

const contentRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../content/docs",
);

/** `01.introduction.md` → `introduction` */
function pageSlugs(folder: string): string[] {
	return readdirSync(resolve(contentRoot, folder))
		.filter((file) => file.endsWith(".md"))
		.map((file) => file.replace(/^\d+\.|\.md$/g, ""));
}

describe("docs sections", () => {
	it("exposes exactly one section, so no sub-header tabs are needed", () => {
		expect(DOCS_SECTION_SLUGS).toEqual(["uxd"]);
	});

	it("resolves the section by slug", () => {
		expect(findDocsSectionBySlug("uxd")?.key).toBe("docs");
		expect(findDocsSectionBySlug("missing")).toBeUndefined();
	});

	it("sources the section from every sidebar group folder, in order", () => {
		expect(DOCS_SECTIONS[0].folder).toBe(DOCS_GROUP_FOLDERS);
		expect(DOCS_GROUP_FOLDERS).toEqual([
			"getting-started",
			"guides",
			"cli",
			"configuration",
		]);
	});

	it("backs every sidebar group with a content folder and a nav title", () => {
		for (const folder of DOCS_GROUP_FOLDERS) {
			expect(existsSync(resolve(contentRoot, folder))).toBe(true);
			expect(existsSync(resolve(contentRoot, folder, ".navigation.yml"))).toBe(
				true,
			);
		}
	});

	it("points the section entry path at a page that exists", () => {
		const entry = DOCS_SECTION_ENTRY_PATHS.uxd;
		expect(entry).toBe(DOCS_GROUP_ENTRY_PATHS["getting-started"]);
		expect(pageSlugs("getting-started")).toContain(
			entry.replace("/docs/uxd/getting-started/", ""),
		);
	});

	it("points each group entry path at a page that exists", () => {
		expect(Object.keys(DOCS_GROUP_ENTRY_PATHS)).toEqual(DOCS_GROUP_FOLDERS);

		for (const folder of DOCS_GROUP_FOLDERS) {
			const prefix = `/docs/uxd/${folder}/`;
			const entry =
				DOCS_GROUP_ENTRY_PATHS[folder as keyof typeof DOCS_GROUP_ENTRY_PATHS];

			expect(entry.startsWith(prefix)).toBe(true);
			expect(pageSlugs(folder)).toContain(entry.slice(prefix.length));
		}
	});
});
