import { describe, expect, it } from 'vitest'

import { Icon } from '../src/web/components/icon'
import { ICONS } from '../src/web/icons'

// The icon contract: labelled or decorative, chosen at every call site.

const render = (node: unknown) => String(node)

describe('Icon', () => {
	it('renders a labelled icon as a named image', () => {
		expect(render(Icon({ name: 'ext', size: 16, label: 'Open on remote.example' }))).toBe(
			`<svg class="ic" width="16" height="16" viewBox="0 0 24 24" role="img" aria-label="Open on remote.example"><path d="${ICONS.ext}"></path></svg>`
		)
	})

	it('renders a decorative icon hidden and unfocusable', () => {
		expect(render(Icon({ name: 'clock', size: 18, decorative: true }))).toBe(
			`<svg class="ic" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${ICONS.clock}"></path></svg>`
		)
	})

	it('escapes its label', () => {
		expect(render(Icon({ name: 'ext', size: 16, label: '"<x>' }))).toContain('aria-label="&quot;&lt;x&gt;"')
	})

	it('makes every call site choose (type checks)', () => {
		// @ts-expect-error neither a label nor decorative
		void Icon({ name: 'x', size: 16 })
		// @ts-expect-error both a label and decorative
		void Icon({ name: 'x', size: 16, label: 'Close', decorative: true })
		// @ts-expect-error a size outside the set (an icon's size follows its text's: 16 or 18)
		void Icon({ name: 'x', size: 14, decorative: true })
		// @ts-expect-error a name outside the set
		void Icon({ name: 'nothing', size: 16, decorative: true })
		expect(true).toBe(true)
	})

	it('has one path of the 24×24 grid per name', () => {
		expect(Object.keys(ICONS)).toHaveLength(24)
		for (const [name, d] of Object.entries(ICONS)) {
			expect(d, name).toMatch(/^M[0-9MmLlHhVvAaCcSsQqTtZz .,-]+$/)
		}
	})
})
