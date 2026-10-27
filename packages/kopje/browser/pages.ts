// The browser job's fixture pages (design §10.11): one of each page type, with the path it is served at and the
// headers it is sent with (headers.ts). fixtures/pages.tsx renders each with the real components; a new page type is
// one more entry here and there.

export const DOMAIN = 'kopje.test'
export const ORIGIN = `https://${DOMAIN}`

// 'l1': a public page that loads the L1 bundle (design §7.5); 'handoff': a handoff page (design §8).
export type PageKind = 'public' | 'l1' | 'private' | 'embed' | 'handoff'

export type FixturePage = { name: string; path: string; status: 200 | 400 | 404; kind: PageKind }

export const PAGES = [
	{ name: 'profile', path: '/@alice', status: 200, kind: 'l1' },
	{ name: 'status', path: '/@alice/102', status: 200, kind: 'l1' },
	{ name: 'thread', path: '/@alice/108', status: 200, kind: 'l1' },
	{ name: 'tag', path: '/tags/walks', status: 200, kind: 'l1' },
	{ name: 'about', path: '/about', status: 200, kind: 'public' },
	{ name: 'document', path: '/privacy-policy', status: 200, kind: 'public' },
	{ name: 'followers', path: '/@alice/followers', status: 200, kind: 'public' },
	{ name: 'follows-hidden', path: '/@carol/following', status: 200, kind: 'public' },
	{ name: 'featured', path: '/@alice/featured', status: 200, kind: 'public' },
	{ name: 'not-found', path: '/@nobody', status: 404, kind: 'public' },
	{ name: 'embed', path: '/@alice/104/embed', status: 200, kind: 'embed' },
	// /authorize_interaction's form, and what a look-up found (its POST answer, served here at a path of its own).
	{ name: 'interaction', path: '/authorize_interaction', status: 200, kind: 'private' },
	{ name: 'interaction-result', path: '/authorize_interaction/result', status: 200, kind: 'private' },
	// The handoff pages: the form without a server, the form refusing one (served at a status's path of its own), and
	// the link to the server given.
	{ name: 'handoff-form', path: '/@alice/interact', status: 200, kind: 'handoff' },
	{ name: 'handoff-refused', path: '/@alice/101/interact', status: 400, kind: 'handoff' },
	{ name: 'handoff', path: '/@alice/102/interact', status: 200, kind: 'handoff' },
	{ name: 'handoff-long', path: '/@bob/interact', status: 200, kind: 'handoff' },
] as const satisfies readonly FixturePage[]

export type PageName = (typeof PAGES)[number]['name']

export function pageNamed(name: PageName): FixturePage {
	return PAGES.find((page) => page.name === name)!
}
