export default defineAppConfig({
	/**
	 * Branding for the docs site. The `@uxfront/layer-docs` layer ships neutral
	 * defaults; these values are merged over them by Nuxt's `defu` layer merge
	 * (consumer wins). This is a clean placeholder scaffold — real marketing and
	 * documentation content land in follow-up work.
	 *
	 * The full shape below (logo, socials, footer.links, toc.bottom) is the
	 * layer's consumer contract: its shell components read these keys, so the
	 * consuming app declares them to type-check even when empty. Values are
	 * neutral placeholders — no logo asset yet (the header falls back to the
	 * title text) and no social/legal/resource links yet.
	 *
	 * @docs https://www.docus.dev/concepts/configuration#global-configuration
	 */
	seo: {
		title: "uxfront",
		titleTemplate: "%s - uxfront",
		description: "The UI UX DX platform documentation.",
	},
	header: {
		title: "uxfront",
		// No logo asset in the scaffold; empty paths make the header render the
		// title text. Drop real light/dark logo paths here when they exist.
		logo: {
			alt: "uxfront",
			light: "",
			dark: "",
		},
		links: [
			{
				label: "Docs",
				// `/docs` redirects to the first Getting Started page.
				to: "/docs",
				activeMatch: "/docs",
			},
		],
	},
	socials: {} as Record<string, string>,
	github: {
		url: "https://github.com/uxfront-com/uxd",
		branch: "main",
	},
	footer: {
		credits: `Copyright © ${new Date().getFullYear()} uxfront`,
		// Legal/nav footer links — none in the scaffold.
		links: [] as Array<{ label: string; to: string; target?: string }>,
	},
	toc: {
		title: "On this page",
		// Right-aside "resources" panel.
		bottom: {
			title: "Resources",
			links: [
				{
					icon: "i-simple-icons-github",
					label: "uxd on GitHub",
					to: "https://github.com/uxfront-com/uxd",
					target: "_blank",
				},
				{
					icon: "i-lucide-bug",
					label: "Report an issue",
					to: "https://github.com/uxfront-com/uxd/issues",
					target: "_blank",
				},
			] as Array<{
				icon: string;
				label: string;
				to: string;
				target?: string;
			}>,
		},
	},
	ui: {
		colors: {
			primary: "green",
			neutral: "slate",
		},
		prose: {
			/*
			 * WCAG 1.4.1 Use of Color.
			 *
			 * Nuxt UI's prose link is `text-primary border-b border-transparent
			 * hover:border-primary` — colour alone until the pointer lands on it.
			 * Measured on the homepage, the green link against the `text-muted`
			 * body it sits in is 1.04:1 (link #008236, body #62748E), far under
			 * the 3:1 that G183 allows colour-only links to rely on, so a
			 * mid-sentence link is indistinguishable from prose without a mouse.
			 *
			 * `border-current` makes the existing 1px bottom border visible at
			 * rest instead of on hover. It is a token-to-token change — the
			 * border simply inherits the link's own colour — and `hover:` /
			 * `focus-visible:` states are untouched.
			 */
			a: {
				base: "border-current",
			},
		},
	},
});
