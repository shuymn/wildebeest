import { describe, expect, it } from 'vitest'

import fixture from './fixtures/mastodon-4.5.11-verifiable.json'
import { verifiableLink } from '../src/domain/field-verification'

// domain/field-verification.ts verifiableLink against Mastodon's Account::Field#verifiable? (v4.5.11, Addressable
// 2.9.0). The fixture is hand-written from the Addressable source, not generated (its `method`): no Ruby with
// Addressable 2.9.0 and idn-ruby was available. Kopje must never verify a value Mastodon would not.

type Case = { value: string; verifiable: boolean; reason: string }
const cases = (fixture as { cases: Case[] }).cases

// Every value Mastodon accepts and Kopje refuses, with Kopje's reason.
const NARROWER: Record<string, string> = {
	'https://x.test..': 'no empty label (the sink refuses the name too)',
	'https://x.test:8443/': 'the default port only, as the sink requests',
	'https://x.test:/': 'an empty port refuses',
	'https://x.test/%2F': 'any % in the path refuses (AM5)',
	'https://x.test/%C3%A9': 'any % in the path refuses (AM5)',
	'https://x.test/%FF': 'any % in the path refuses (AM5)',
	'https://x.test/?q=a b': 'printable ASCII only',
	'https://[::1]/': 'LDH and underscore labels only (the sink refuses a literal IP too)',
	'https://0x7f.1/': 'the WHATWG parser reads it as 127.0.0.1, another host',
	[`https://${'a'.repeat(64)}.test/`]: 'labels of at most 63 characters',
}

describe('verifiableLink', () => {
	it('never accepts a value Mastodon refuses, and lists every value Mastodon accepts that it refuses', () => {
		expect((fixture as { generated: boolean }).generated).toBe(false)
		for (const { value, verifiable } of cases) {
			if (verifiableLink(value)) {
				expect(verifiable, value).toBe(true)
			}
		}
		const narrower = cases.filter((c) => c.verifiable && !verifiableLink(c.value)).map((c) => c.value)
		expect(narrower.sort()).toEqual(Object.keys(NARROWER).sort())
	})

	it.each([
		'https://x.test/e%CC%81',
		'https://x.test/%c3%a9',
		'https://exa%6Dple.test',
		'https://x.test/a\u0000',
		'https://x.test/é',
		'https://x.test:0443/',
		'https://x.test/a\\b',
		'https://x.test/a|b',
		'https://1.2.3/',
		'',
	])('refuses %j', (value) => {
		expect(verifiableLink(value)).toBe(false)
	})
})
