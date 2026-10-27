import { describe, expect, it } from 'vitest'

import { type Clip, enableCopy } from '../src/client/copy.js'
import { STRINGS } from '../src/web/strings.js'

// The copy control (design §7.7) on stub elements: it shows the hidden controls of each copy field, copies the value
// the server put in data-copy, and writes the catalogue's result text from the page into the field's status element,
// as text only. The browser job runs the real bundle in Chromium under the production CSP and Trusted Types.

// A status element: the control writes only its text.
class Status {
	textContent: string | null = ''
}

class Button {
	hidden = true
	readonly listeners: (() => void)[] = []
	constructor(
		readonly attributes: Record<string, string>,
		readonly field: { querySelector(selector: string): Status | null } | null
	) {}
	getAttribute(name: string): string | null {
		return this.attributes[name] ?? null
	}
	closest(selector: string) {
		expect(selector).toBe('.copyfield')
		return this.field
	}
	addEventListener(type: string, listener: () => void) {
		expect(type).toBe('click')
		this.listeners.push(listener)
	}
	click() {
		for (const listener of this.listeners) {
			listener()
		}
	}
}

const ATTRIBUTES = {
	'data-copy': '@alice@kopje.test',
	'data-copied': STRINGS.copy.copied,
	'data-failed': STRINGS.copy.failed,
}

// A copy field with its status element, and the page holding its buttons.
function field(attributes: Record<string, string> = ATTRIBUTES) {
	const status = new Status()
	const button = new Button(attributes, {
		querySelector(selector: string) {
			expect(selector).toBe('[role="status"]')
			return status
		},
	})
	return { status, button }
}

function page(buttons: Button[]): ParentNode {
	return {
		querySelectorAll(selector: string) {
			expect(selector).toBe('.copyfield button[data-copy]')
			return buttons
		},
	} as unknown as ParentNode
}

// A clipboard that records what it was given, answering each call with `outcome`.
function clipboard(outcome: 'ok' | 'refused') {
	const written: string[] = []
	const clip: Clip = {
		writeText(text: string) {
			written.push(text)
			return outcome === 'ok' ? Promise.resolve() : Promise.reject(new DOMException('denied', 'NotAllowedError'))
		},
	}
	return { clip, written }
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('the copy control', () => {
	it('shows each control and copies its value, writing the page’s result text, again on every click', async () => {
		const [a, b] = [field(), field({ ...ATTRIBUTES, 'data-copy': 'https://kopje.test/@alice/1' })]
		const { clip, written } = clipboard('ok')
		enableCopy(page([a.button, b.button]), clip)
		expect([a.button.hidden, b.button.hidden]).toEqual([false, false])
		expect(a.status.textContent).toBe('')
		a.button.click()
		// Emptied at once, so the same result is announced again.
		expect(a.status.textContent).toBe('')
		await settled()
		expect(a.status.textContent).toBe('Copied')
		b.button.click()
		a.button.click()
		await settled()
		expect(written).toEqual(['@alice@kopje.test', 'https://kopje.test/@alice/1', '@alice@kopje.test'])
		expect([a.status.textContent, b.status.textContent]).toEqual(['Copied', 'Copied'])
	})

	it('writes the page’s failure text when the clipboard refuses', async () => {
		const a = field()
		const { clip, written } = clipboard('refused')
		enableCopy(page([a.button]), clip)
		a.button.click()
		await settled()
		expect(written).toEqual(['@alice@kopje.test'])
		expect(a.status.textContent).toBe(STRINGS.copy.failed)
	})

	it('leaves the controls hidden without the Clipboard API, and a control without a status element', async () => {
		const a = field()
		enableCopy(page([a.button]), undefined)
		expect(a.button.hidden).toBe(true)
		expect(a.button.listeners).toEqual([])
		// A control outside a copy field, or in one without its status element.
		const lone = new Button(ATTRIBUTES, null)
		const mute = new Button(ATTRIBUTES, { querySelector: () => null })
		const shown = field()
		enableCopy(page([lone, mute, shown.button]), clipboard('ok').clip)
		expect([lone.hidden, mute.hidden, shown.button.hidden]).toEqual([true, true, false])
	})
})
