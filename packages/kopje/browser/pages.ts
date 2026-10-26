// The browser job's fixture pages (design §10.11): one of each page type, with the path it is served at and the
// headers it is sent with (headers.ts). fixtures/pages.tsx renders each with the real components; a new page type is
// one more entry here and there.

export const DOMAIN = 'kopje.test'
export const ORIGIN = `https://${DOMAIN}`

export type PageKind = 'public' | 'embed'

export type FixturePage = { name: string; path: string; status: 200 | 404; kind: PageKind }

export const PAGES = [
	{ name: 'profile', path: '/@alice', status: 200, kind: 'public' },
	{ name: 'status', path: '/@alice/102', status: 200, kind: 'public' },
	{ name: 'about', path: '/about', status: 200, kind: 'public' },
	{ name: 'document', path: '/privacy-policy', status: 200, kind: 'public' },
	{ name: 'not-found', path: '/@nobody', status: 404, kind: 'public' },
	{ name: 'embed', path: '/@alice/104/embed', status: 200, kind: 'embed' },
] as const satisfies readonly FixturePage[]

export type PageName = (typeof PAGES)[number]['name']

export function pageNamed(name: PageName): FixturePage {
	return PAGES.find((page) => page.name === name)!
}
