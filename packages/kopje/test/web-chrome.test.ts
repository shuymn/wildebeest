import { describe, expect, it } from 'vitest'

import { setSetting } from './api-helpers'
import { community, post } from './status-helpers'
import { attr, type Document, elements, one, parseHtml, query, text } from './web-dom'

// The page frame: the skip link first, the header naming the instance and linking /about, main, and the footer with
// the about link, the documents that exist (each page read loads them), and "Powered by Kopje" as text.

type Harness = Awaited<ReturnType<typeof community>>

async function document(h: Harness, path: string): Promise<Document> {
	return parseHtml(await (await h.request(path)).text())
}

function links(root: Parameters<typeof query>[0]): { href: string | null; text: string; current: string | null }[] {
	return query(root, 'a').map((a) => ({ href: attr(a, 'href'), text: text(a), current: attr(a, 'aria-current') }))
}

// "Powered by Kopje" is text, never a link.
const poweredBy = (footer: Parameters<typeof query>[0]) =>
	query(footer, 'span')
		.map(text)
		.filter((t) => t.includes('Kopje'))

describe('site header and footer', () => {
	it('frame every public page: skip link, the domain linking /about, main#content and the footer', async () => {
		const h = await community(['alice'])
		const status = await post(h, h.users.alice, { status: 'hello' })
		await setSetting(h.store, 'privacy_policy', '<p>Policy</p>')
		for (const path of ['/@alice', new URL(String(status.url)).pathname, '/privacy-policy', '/@nobody']) {
			const doc = await document(h, path)
			const body = one(doc, 'body')
			const first = elements(body).find((e) => e.tagName === 'a')
			expect(first && attr(first, 'href'), path).toBe('#content')
			expect(first && text(first)).toBe('Skip to content')
			expect(attr(one(doc, 'main'), 'id')).toBe('content')
			expect(links(one(doc, 'header'))).toEqual([{ href: '/about', text: 'kopje.test', current: null }])
			const footer = one(doc, 'footer')
			expect(links(footer), path).toEqual([
				{ href: '/about', text: 'About this server', current: null },
				{ href: '/privacy-policy', text: 'Privacy policy', current: null },
			])
			expect(poweredBy(footer)).toEqual(['Powered by Kopje'])
		}
	})

	it('mark /about as the current page and link the documents that exist', async () => {
		const h = await community(['alice'])
		const before = await document(h, '/about')
		expect(links(one(before, 'header'))).toEqual([{ href: '/about', text: 'kopje.test', current: 'page' }])
		expect(links(one(before, 'footer'))).toEqual([{ href: '/about', text: 'About this server', current: 'page' }])
		await setSetting(h.store, 'privacy_policy', '<p>Policy</p>')
		await setSetting(h.store, 'terms_of_service', '<p>Terms</p>')
		await setSetting(h.store, 'terms_of_service_effective_date', '2026-11-01')
		const after = await document(h, '/about')
		expect(links(one(after, 'footer'))).toEqual([
			{ href: '/about', text: 'About this server', current: 'page' },
			{ href: '/terms-of-service', text: 'Terms of service', current: null },
			{ href: '/privacy-policy', text: 'Privacy policy', current: null },
		])
		expect(poweredBy(one(after, 'footer'))).toEqual(['Powered by Kopje'])
	})
})
