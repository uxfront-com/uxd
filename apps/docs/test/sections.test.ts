import { describe, expect, it } from "vitest";
import {
	DOCS_SECTIONS,
	DOCS_SECTION_SLUGS,
	findDocsSectionBySlug,
} from "../app/constants/sections";

describe("docs sections", () => {
	it("exposes at least one documentation section", () => {
		expect(DOCS_SECTIONS.length).toBeGreaterThan(0);
	});

	it("derives slugs from the sections", () => {
		expect(DOCS_SECTION_SLUGS).toContain("getting-started");
	});

	it("resolves a section by slug", () => {
		expect(findDocsSectionBySlug("getting-started")?.key).toBe(
			"gettingStarted",
		);
		expect(findDocsSectionBySlug("missing")).toBeUndefined();
	});
});
