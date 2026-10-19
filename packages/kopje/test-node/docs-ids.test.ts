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

const threatIds = (text: string) => [...text.matchAll(/^- \*\*([A-Z]+-\d+[a-z]?):/gm)].map((m) => m[1] ?? '')

function ruleIds(text: string): string[] {
	const section = text.split('\n## The rules as the module implements them\n')[1] ?? ''
	const table = section.split('\n## ')[0] ?? ''
	return [...table.matchAll(/^\| ([^|]+)\|/gm)].flatMap((m) => (m[1] ?? '').match(/\bR\d+\b/g) ?? [])
}

describe('document ids', () => {
	it('defines each threat-model id once', () => {
		const ids = threatIds(doc('threat-model.md'))
		expect(ids.length).toBeGreaterThan(50)
		expect(repeated(ids)).toEqual([])
	})

	it('defines each visibility rule once', () => {
		const ids = ruleIds(doc('visibility.md'))
		expect(ids.length).toBeGreaterThan(20)
		expect(repeated(ids)).toEqual([])
	})

	it('finds an id defined twice, and not one only cited again', () => {
		const threats = '- **VIS-1: a.** text\n- **VIS-2: b.** VIS-1 again\n- **VIS-1: c.** text\n'
		expect(repeated(threatIds(threats))).toEqual(['VIS-1'])
		const rules = [
			'## The rules as the module implements them',
			'',
			'| Rule | Code |',
			'| R1 read, R2 list | R1 cited |',
			'| R2 again | x |',
			'',
			'## Next',
			'| R3 | x |',
			'| R3 | x |',
		].join('\n')
		expect(repeated(ruleIds(`\n${rules}`))).toEqual(['R2'])
	})
})
