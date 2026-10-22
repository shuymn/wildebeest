import { describe, expect, it } from 'vitest'

import { Icon } from '../src/web/components/icon'
import { ICONS } from '../src/web/icons'

// The icon contract (design §11, §14.6): labelled or decorative, chosen at every call site.

const render = (node: unknown) => String(node)

describe('Icon', () => {
	it('renders a labelled icon as a named image', () => {
		expect(render(Icon({ name: 'ext', size: 14, label: 'Open on remote.example' }))).toBe(
			`<svg class="ic" width="14" height="14" viewBox="0 0 24 24" role="img" aria-label="Open on remote.example"><path d="${ICONS.ext}"></path></svg>`
		)
	})

	it('renders a decorative icon hidden and unfocusable', () => {
		expect(render(Icon({ name: 'server', size: 20, decorative: true }))).toBe(
			`<svg class="ic" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${ICONS.server}"></path></svg>`
		)
	})

	it('escapes its label', () => {
		expect(render(Icon({ name: 'ext', size: 14, label: '"<x>' }))).toContain('aria-label="&quot;&lt;x&gt;"')
	})

	it('makes every call site choose (type checks)', () => {
		// @ts-expect-error neither a label nor decorative
		void Icon({ name: 'x', size: 16 })
		// @ts-expect-error both a label and decorative
		void Icon({ name: 'x', size: 16, label: 'Close', decorative: true })
		// @ts-expect-error a size outside the set
		void Icon({ name: 'x', size: 15, decorative: true })
		// @ts-expect-error a name outside the set
		void Icon({ name: 'nothing', size: 16, decorative: true })
		expect(true).toBe(true)
	})

	it('has one path of the 24×24 grid per name', () => {
		expect(Object.keys(ICONS)).toHaveLength(23)
		for (const [name, d] of Object.entries(ICONS)) {
			expect(d, name).toMatch(/^M[0-9MmLlHhVvAaCcSsQqTtZz .,-]+$/)
		}
	})
})
