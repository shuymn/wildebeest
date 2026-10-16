import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

// The two scripts of an embed (public/assets): embed.js, which the oEmbed HTML loads on the embedding page, frames each
// embed quote of this instance and sizes the frame to the height the embed page reports; embed-status.js, on the embed
// page, reports it when asked. Run against stand-ins for the DOM objects they touch.

const asset = (name: string) => readFileSync(new URL(`../public/assets/${name}`, import.meta.url), 'utf8')
const EMBED = asset('embed.js')
const EMBED_STATUS = asset('embed-status.js')

type Listener = (event: { source?: unknown; data?: unknown }) => void

function listeners() {
	const all = new Map<string, Listener[]>()
	return {
		add: (type: string, listener: Listener) => all.set(type, [...(all.get(type) ?? []), listener]),
		fire: (type: string, event: { source?: unknown; data?: unknown } = {}) => {
			for (const listener of all.get(type) ?? []) {
				listener(event)
			}
		},
	}
}

describe('embed-status.js', () => {
	function page() {
		const posted: [unknown, string][] = []
		const parent = { postMessage: (message: unknown, origin: string) => posted.push([message, origin]) }
		const win = listeners()
		const doc = listeners()
		const body = { style: { overflow: '' } }
		const window = { parent, addEventListener: win.add }
		const document = { documentElement: { scrollHeight: 321 }, body, addEventListener: doc.add }
		runInNewContext(EMBED_STATUS, { window, document })
		return { posted, parent, win, doc, body, document }
	}

	it("answers the parent's height request with the page's height, and again when a section opens", () => {
		const p = page()
		p.doc.fire('toggle')
		expect(p.posted).toEqual([])
		p.win.fire('message', { source: p.parent, data: { type: 'setHeight', id: 7 } })
		expect(p.posted).toEqual([[{ type: 'setHeight', id: 7, height: 321 }, '*']])
		expect(p.body.style.overflow).toBe('hidden')
		p.document.documentElement.scrollHeight = 500
		p.doc.fire('toggle')
		expect(p.posted.at(-1)).toEqual([{ type: 'setHeight', id: 7, height: 500 }, '*'])
	})

	it('ignores other messages and other senders', () => {
		const p = page()
		p.win.fire('message', { source: {}, data: { type: 'setHeight', id: 7 } })
		p.win.fire('message', { source: p.parent, data: { type: 'other', id: 7 } })
		p.win.fire('message', { source: p.parent, data: null })
		p.win.fire('message', { source: p.parent, data: 'setHeight' })
		expect(p.posted).toEqual([])
		expect(p.body.style.overflow).toBe('')
	})
})

describe('embed.js', () => {
	type Frame = {
		src: string
		width: string
		height: string
		allow: string
		attributes: Record<string, string>
		style: Record<string, string>
		onload: (() => void) | null
		contentWindow: { postMessage: (message: unknown, origin: string) => void }
		setAttribute: (name: string, value: string) => void
	}

	function quote(embedUrl: string) {
		const attributes: Record<string, string | undefined> = { 'data-embed-url': embedUrl }
		const children: unknown[] = []
		const container = {
			clientWidth: 480,
			children,
			getAttribute: (name: string) => attributes[name] ?? null,
			setAttribute: (name: string, value: string) => (attributes[name] = value),
			appendChild: (child: unknown) => children.push(child),
			removeChild: (child: unknown) => children.splice(children.indexOf(child), 1),
			querySelector: (selector: string) => (selector === 'a' ? placeholder : null),
		}
		const placeholder = { parentNode: container as typeof container | null }
		children.push(placeholder)
		return { container, placeholder, children }
	}

	function embedding(quotes: ReturnType<typeof quote>[], prefixes = 'https://kopje.test/') {
		const win = listeners()
		const frames: Frame[] = []
		const posted: [unknown, string][] = []
		const document = {
			readyState: 'complete',
			currentScript: { dataset: { allowedPrefixes: prefixes } },
			querySelectorAll: (selector: string) =>
				selector === 'blockquote.mastodon-embed' ? quotes.map((q) => q.container) : [],
			createElement: () => {
				const frame: Frame = {
					src: '',
					width: '',
					height: '',
					allow: '',
					attributes: {},
					style: {},
					onload: null,
					contentWindow: { postMessage: (message, origin) => posted.push([message, origin]) },
					setAttribute: (name, value) => (frame.attributes[name] = value),
				}
				frames.push(frame)
				return frame
			},
		}
		const window = { addEventListener: win.add }
		const run = () => {
			runInNewContext(EMBED, { window, document, URL })
		}
		run()
		return { win, frames, posted, run }
	}

	it("frames this instance's embed page and sizes the frame to the height it reports", () => {
		const q = quote('https://kopje.test/@alice/1/embed')
		const e = embedding([q])
		expect(e.frames).toHaveLength(1)
		const frame = e.frames[0] as Frame
		expect(frame.src).toBe('https://kopje.test/@alice/1/embed')
		expect(frame.width).toBe('480')
		expect(frame.height).toBe('0')
		expect(frame.attributes.sandbox).toBe('allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox')
		expect(q.children).toEqual([q.placeholder, frame])
		frame.onload?.()
		expect(e.posted).toHaveLength(1)
		const [request, origin] = e.posted[0] as [{ type: string; id: number }, string]
		expect(request.type).toBe('setHeight')
		expect(origin).toBe('https://kopje.test')
		// Another window's answer, an unknown id and a height that is not a number change nothing.
		e.win.fire('message', { source: {}, data: { type: 'setHeight', id: request.id, height: 99 } })
		e.win.fire('message', { source: frame.contentWindow, data: { type: 'setHeight', id: request.id + 1, height: 99 } })
		e.win.fire('message', { source: frame.contentWindow, data: { type: 'setHeight', id: request.id, height: 'tall' } })
		expect(frame.height).toBe('0')
		expect(q.children).toContain(q.placeholder)
		e.win.fire('message', { source: frame.contentWindow, data: { type: 'setHeight', id: request.id, height: 250.4 } })
		expect(frame.height).toBe('251')
		expect(q.children).toEqual([frame])
		e.win.fire('message', { source: frame.contentWindow, data: { type: 'setHeight', id: request.id, height: 300 } })
		expect(frame.height).toBe('300')
	})

	it('frames no page outside the allowed prefixes, and each quote once however many copies run', () => {
		const quotes = [
			'https://evil.example/@alice/1/embed',
			'https://kopje.test.evil.example/@alice/1/embed',
			'javascript:alert(1)//https://kopje.test/',
			'not a url',
			'',
		].map(quote)
		const e = embedding(quotes)
		expect(e.frames).toEqual([])
		expect(embedding([quote('https://kopje.test/@alice/1/embed')], '').frames).toEqual([])
		const own = quote('https://kopje.test/@alice/2/embed')
		const twice = embedding([own])
		twice.run()
		expect(twice.frames).toHaveLength(1)
	})
})
