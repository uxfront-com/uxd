export const DOCS_SECTIONS = [
	{
		key: "gettingStarted",
		slug: "getting-started",
		folder: "getting-started",
		label: "Getting Started",
		icon: "i-lucide-rocket",
	},
] as const;

export type DocsSection = (typeof DOCS_SECTIONS)[number];
export type DocsSectionKey = DocsSection["key"];
export type DocsSectionSlug = DocsSection["slug"];

export const DOCS_SECTION_SLUGS = DOCS_SECTIONS.map(
	(section) => section.slug,
) as readonly DocsSectionSlug[];

export function findDocsSectionBySlug(slug: string): DocsSection | undefined {
	return DOCS_SECTIONS.find((section) => section.slug === slug);
}
