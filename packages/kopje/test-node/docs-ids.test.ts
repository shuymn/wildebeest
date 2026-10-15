import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// The ids other documents, code comments and tests cite: each threat-model entry (`- **VIS-17: ...**`) and each rule of
// docs/visibility.md's rule table (`| R18 reblog, R19 favourite |`) is defined once. Branches written in parallel each
// take the next free id, so a merge can bring two definitions of one id.
function doc(name: string): string {
	return readFileSync(new URL(`../docs/${name}`, import.meta.url), 'utf8')
}

function repeated(ids: readonly string[]): string[] {
	return [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]
}

describe('document ids', () => {
	it('defines each threat-model id once', () => {
		const ids = [...doc('threat-model.md').matchAll(/^- \*\*([A-Z]+-\d+[a-z]?):/gm)].map((m) => m[1] ?? '')
		expect(ids.length).toBeGreaterThan(50)
		expect(repeated(ids)).toEqual([])
	})

	it('defines each visibility rule once', () => {
		const section = doc('visibility.md').split('\n## The rules as the module implements them\n')[1] ?? ''
		const table = section.split('\n## ')[0] ?? ''
		const ids = [...table.matchAll(/^\| ([^|]+)\|/gm)].flatMap((m) => (m[1] ?? '').match(/\bR\d+\b/g) ?? [])
		expect(ids.length).toBeGreaterThan(20)
		expect(repeated(ids)).toEqual([])
	})
})
