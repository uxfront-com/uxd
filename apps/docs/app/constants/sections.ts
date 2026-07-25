/**
 * Documentation information architecture.
 *
 * Each entry becomes a top-level tab in the docs sub-header, a Nuxt Content
 * collection (`docs_<key>`), and a sidebar tree built from the files under
 * `content/docs/<folder>/`. Sections follow the reader's journey: learn it,
 * do a task with it, look a command up, configure it.
 */
export const DOCS_SECTIONS = [
	{
		key: "gettingStarted",
		slug: "getting-started",
		folder: "getting-started",
		label: "Getting Started",
		icon: "i-lucide-rocket",
	},
	{
		key: "guides",
		slug: "guides",
		folder: "guides",
		label: "Guides",
		icon: "i-lucide-book-open",
	},
	{
		key: "cli",
		slug: "cli",
		folder: "cli",
		label: "CLI Reference",
		icon: "i-lucide-terminal",
	},
	{
		key: "configuration",
		slug: "configuration",
		folder: "configuration",
		label: "Configuration",
		icon: "i-lucide-settings",
	},
] as const;

export type DocsSection = (typeof DOCS_SECTIONS)[number];
export type DocsSectionKey = DocsSection["key"];
export type DocsSectionSlug = DocsSection["slug"];

/**
 * First page of each section. Section roots (`/docs/<slug>`) carry no page of
 * their own, so `/docs` and each section root redirect here.
 */
export const DOCS_SECTION_ENTRY_PATHS = {
	"getting-started": "/docs/getting-started/introduction",
	guides: "/docs/guides/review-a-pull-request",
	cli: "/docs/cli/overview",
	configuration: "/docs/configuration/overview",
} as const satisfies Record<DocsSectionSlug, string>;

export const DOCS_SECTION_SLUGS = DOCS_SECTIONS.map(
	(section) => section.slug,
) as readonly DocsSectionSlug[];

export function findDocsSectionBySlug(slug: string): DocsSection | undefined {
	return DOCS_SECTIONS.find((section) => section.slug === slug);
}
