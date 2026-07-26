/**
 * Documentation information architecture.
 *
 * uxd's documentation is a **single** section. The reader's journey — learn it,
 * do a task with it, look a command up, configure it — survives as the four
 * sidebar groups listed in {@link DOCS_GROUP_FOLDERS}, not as top-level tabs:
 * with one section there is nothing to switch between, so the section
 * sub-header has no reason to exist.
 *
 * The layer builds everything from the descriptor below: one Nuxt Content
 * collection (`docs_docs`) sourced from every folder in `folder`, and a sidebar
 * tree whose top level is those folders in array order.
 */

/**
 * Sidebar groups, in reading order, as folder names under `content/docs/`.
 *
 * Array order is the sidebar order — it is not alphabetical and must not be
 * sorted. Each folder carries a `.navigation.yml` supplying the group's label.
 * Each name is also the second URL segment: `/docs/uxd/<folder>/<page>`.
 *
 * Typed as mutable `string[]` (not a `readonly` tuple) so the object below
 * still satisfies the layer's `DocsSectionDescriptor.folder: string | string[]`
 * under `as const`.
 */
export const DOCS_GROUP_FOLDERS: string[] = [
	"getting-started",
	"guides",
	"cli",
	"configuration",
];

export const DOCS_SECTIONS = [
	{
		key: "docs",
		slug: "uxd",
		folder: DOCS_GROUP_FOLDERS,
		label: "Documentation",
		icon: "i-lucide-book-open",
	},
] as const;

export type DocsSection = (typeof DOCS_SECTIONS)[number];
export type DocsSectionKey = DocsSection["key"];
export type DocsSectionSlug = DocsSection["slug"];

/**
 * First page of the section. The section root (`/docs/uxd`) carries no page of
 * its own — the sidebar is built from its children — so `/docs` and
 * `/docs/uxd` both redirect here.
 */
export const DOCS_SECTION_ENTRY_PATHS = {
	uxd: "/docs/uxd/getting-started/introduction",
} as const satisfies Record<DocsSectionSlug, string>;

/**
 * First page of each sidebar group, keyed by folder name.
 *
 * Two jobs: it gives every group root (`/docs/uxd/<folder>`, which has no page
 * of its own) a redirect target, and it gives the pre-consolidation URLs
 * (`/docs/<folder>`, when each folder was its own section) somewhere to land.
 */
export const DOCS_GROUP_ENTRY_PATHS = {
	"getting-started": "/docs/uxd/getting-started/introduction",
	guides: "/docs/uxd/guides/review-a-pull-request",
	cli: "/docs/uxd/cli/overview",
	configuration: "/docs/uxd/configuration/overview",
} as const satisfies Record<string, string>;

export const DOCS_SECTION_SLUGS = DOCS_SECTIONS.map(
	(section) => section.slug,
) as readonly DocsSectionSlug[];

export function findDocsSectionBySlug(slug: string): DocsSection | undefined {
	return DOCS_SECTIONS.find((section) => section.slug === slug);
}
