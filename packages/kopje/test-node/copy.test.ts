import { describe, expect, it } from 'vitest'

import { type Clip, COPIED_MS, enableCopy } from '../src/client/copy.js'

// The copy control (design §7.7) on stub elements: it shows the hidden controls of each copy field, copies the value
// the server put in data-copy, and writes the catalogue's result text from the page into the field's status element,
// as text only. The browser job runs the real bundle in Chromium under the production CSP and Trusted Types.

// A status element: the control writes only its text.
class Status {
	textContent: string | null = ''
}

// The dialog a field sits in: the control listens for its close.
class Dialog {
	readonly listeners: (() => void)[] = []
	addEventListener(type: string, listener: () => void) {
		expect(type).toBe('close')
		this.listeners.push(listener)
	}
	close() {
		for (const listener of this.listeners) {
			listener()
		}
	}
}

class Button {
	hidden = true
	readonly listeners: (() => void)[] = []
	// The attributes the control sets (data-state), apart from the server's.
	readonly set: Record<string, string> = {}
	constructor(
		readonly attributes: Record<string, string>,
		readonly field: { querySelector(selector: string): Status | null } | null,
		readonly dialog: Dialog | null = null
	) {}
	getAttribute(name: string): string | null {
		return this.set[name] ?? this.attributes[name] ?? null
	}
	setAttribute(name: string, value: string) {
		expect(name).toBe('data-state')
		this.set[name] = value
	}
	removeAttribute(name: string) {
		expect(name).toBe('data-state')
		delete this.set[name]
	}
	get state(): string | null {
		return this.set['data-state'] ?? null
	}
	closest(selector: string) {
		expect(['.copyfield', 'dialog']).toContain(selector)
		return selector === 'dialog' ? this.dialog : this.field
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

// The catalogue's result texts (src/web/strings.ts, copy), as the page writes them into its data-* attributes.
const COPIED = 'Copied'
const FAILED = 'Could not copy. Select the text and copy it instead.'

const ATTRIBUTES = {
	'data-copy': '@alice@kopje.test',
	'data-copied': COPIED,
	'data-failed': FAILED,
}

// A copy field with its status element, and the page holding its buttons.
function field(attributes: Record<string, string> = ATTRIBUTES, dialog: Dialog | null = null) {
	const status = new Status()
	const button = new Button(
		attributes,
		{
			querySelector(selector: string) {
				expect(selector).toBe('[role="status"]')
				return status
			},
		},
		dialog
	)
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

	it('empties the result when the field’s dialog closes, so a dialog opened again shows none', async () => {
		const dialog = new Dialog()
		const [inDialog, onPage] = [field(ATTRIBUTES, dialog), field()]
		enableCopy(page([inDialog.button, onPage.button]), clipboard('ok').clip)
		inDialog.button.click()
		onPage.button.click()
		await settled()
		expect([inDialog.status.textContent, onPage.status.textContent]).toEqual(['Copied', 'Copied'])
		dialog.close()
		expect([inDialog.status.textContent, onPage.status.textContent]).toEqual(['', 'Copied'])
	})

	it('writes the page’s failure text when the clipboard refuses', async () => {
		const a = field()
		const { clip, written } = clipboard('refused')
		enableCopy(page([a.button]), clip)
		a.button.click()
		await settled()
		expect(written).toEqual(['@alice@kopje.test'])
		expect(a.status.textContent).toBe(FAILED)
	})

	it('marks the button copied for COPIED_MS after a success, failed until the next click after a refusal', async () => {
		const timers: { run: () => void; ms: number }[] = []
		const later = (run: () => void, ms: number) => void timers.push({ run, ms })
		const ok = field()
		enableCopy(page([ok.button]), clipboard('ok').clip, later)
		expect(ok.button.state).toBeNull()
		ok.button.click()
		await settled()
		expect([ok.button.state, ok.status.textContent]).toEqual(['copied', COPIED])
		expect(timers.map((timer) => timer.ms)).toEqual([COPIED_MS])
		timers[0]!.run()
		expect([ok.button.state, ok.status.textContent]).toEqual([null, COPIED])
		// A later click's success is not cut short by an earlier one's timer.
		ok.button.click()
		await settled()
		ok.button.click()
		await settled()
		timers[1]!.run()
		expect(ok.button.state).toBe('copied')
		timers[2]!.run()
		expect(ok.button.state).toBeNull()

		const refused = field()
		enableCopy(page([refused.button]), clipboard('refused').clip, later)
		refused.button.click()
		await settled()
		expect([refused.button.state, refused.status.textContent]).toEqual(['failed', FAILED])
		expect(timers).toHaveLength(3)
		// The next click resets it before its own result.
		refused.button.click()
		expect([refused.button.state, refused.status.textContent]).toEqual([null, ''])
	})

	// A clipboard whose calls settle when the test says, in any order.
	function deferred() {
		const calls: { resolve: () => void; reject: () => void }[] = []
		const clip: Clip = {
			writeText: () =>
				new Promise<void>((resolve, reject) => {
					calls.push({ resolve, reject: () => reject(new DOMException('denied', 'NotAllowedError')) })
				}),
		}
		return { clip, calls }
	}

	it('ignores a result that settles after the dialog closed, success or refusal', async () => {
		for (const outcome of ['resolve', 'reject'] as const) {
			const dialog = new Dialog()
			const a = field(ATTRIBUTES, dialog)
			const { clip, calls } = deferred()
			enableCopy(page([a.button]), clip, () => undefined)
			a.button.click()
			dialog.close()
			calls[0]![outcome]()
			await settled()
			expect([a.button.state, a.status.textContent], outcome).toEqual([null, ''])
		}
	})

	it('shows the newest click’s result when earlier ones settle after it', async () => {
		const a = field()
		const { clip, calls } = deferred()
		enableCopy(page([a.button]), clip, () => undefined)
		a.button.click()
		a.button.click()
		// The newer click succeeds first; the older one's refusal arrives later and changes nothing.
		calls[1]!.resolve()
		await settled()
		calls[0]!.reject()
		await settled()
		expect([a.button.state, a.status.textContent]).toEqual(['copied', COPIED])
		// And the other way round: an older success after a newer refusal.
		a.button.click()
		a.button.click()
		calls[3]!.reject()
		await settled()
		calls[2]!.resolve()
		await settled()
		expect([a.button.state, a.status.textContent]).toEqual(['failed', FAILED])
	})

	it('resets the state with the text when the field’s dialog closes', async () => {
		const dialog = new Dialog()
		const a = field(ATTRIBUTES, dialog)
		enableCopy(page([a.button]), clipboard('refused').clip, () => undefined)
		a.button.click()
		await settled()
		expect(a.button.state).toBe('failed')
		dialog.close()
		expect([a.button.state, a.status.textContent]).toEqual([null, ''])
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
