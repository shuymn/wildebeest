import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import {
	accountAtCap,
	emojiUrl,
	escaped,
	maximalEntry,
	padded,
	type Pairs,
	shortcode,
	statusAtCap,
	statusShortNames,
} from './emoji-fixtures'
import { freshStore } from './helpers'
import {
	ACCOUNT_EMOJIS_BYTES,
	emojisPastBoundSql,
	emojisValid,
	MAX_EMOJIS,
	presentedEmojiBytes,
	STATUS_EMOJIS_BYTES,
} from '../src/platform/stored-bounds'

// RES-2: the stored bound of the emoji snapshot columns (migration 0053_custom_emoji_snapshots). Each literal input
// has its own expected verdict, written by hand, which both the SQL predicate (as the triggers run it) and its JS
// twin must give.

const S = STATUS_EMOJIS_BYTES
const A = ACCOUNT_EMOJIS_BYTES
const ok = (pairs: Pairs) => JSON.stringify(pairs)
const one = (name: string, url = 'http://a/') => ok([[name, url]])

// [case, stored text, bound, valid]
const CASES: [string, string, number, boolean][] = [
	['the smallest snapshot', one('a'), S, true],
	['a scheme of https', one('a', 'https://a/'), S, true],
	['every shortcode character', one('AZaz09_+-'), S, true],
	['JSON whitespace between tokens', ' [ [ "a" , "http://a/" ] ] ', S, true],
	['malformed JSON', '[["a","http://a/"]', S, false],
	['text that is not JSON', 'a', S, false],
	['a scalar', '"a"', S, false],
	['a number', '1', S, false],
	['an object', '{"a":"http://a/"}', S, false],
	['an empty array', '[]', S, false],
	['a scalar element', '["a"]', S, false],
	['an object element', '[{"a":"http://a/"}]', S, false],
	['a nested array as name', '[[["a"],"http://a/"]]', S, false],
	['an element of one', '[["a"]]', S, false],
	['an element of three', '[["a","http://a/","x"]]', S, false],
	['a number as name', '[[1,"http://a/"]]', S, false],
	['a null url', '[["a",null]]', S, false],
	[
		'a repeated name',
		ok([
			['a', 'http://a/'],
			['a', 'http://b/'],
		]),
		S,
		false,
	],
	[
		'names that differ in case',
		ok([
			['a', 'http://a/'],
			['A', 'http://b/'],
		]),
		S,
		true,
	],
	['an empty name', one(''), S, false],
	['a name with a colon', one(':a:'), S, false],
	['a name with a space', one('a b'), S, false],
	['a name with an escaped NUL', '[["a\\u0000","http://a/"]]', S, false],
	['a name with a raw NUL', '[["a\u0000","http://a/"]]', S, false],
	['a complete value followed by a raw NUL and junk', '[["a","http://a/"]]\u0000junk', S, false],
	['a complete value, whitespace and a raw NUL', '[["a","http://a/"]] \u0000', S, false],
	['a non-ASCII name', one('é'), S, false],
	['an escaped non-ASCII name', '[["\\u00e9","http://a/"]]', S, false],
	['an astral name', one('😀'), S, false],
	['an escaped astral name', '[["\\ud83d\\ude00","http://a/"]]', S, false],
	['an escaped lone surrogate', '[["\\ud800","http://a/"]]', S, false],
	['a name escaped as ASCII', '[["\\u0061","http://a/"]]', S, true],
	['a name of 128', one(shortcode(128, 0)), S, true],
	['a name of 129', one(shortcode(129, 0)), S, false],
	['a url with a quote', '[["a","http://a/\\""]]', S, false],
	['a url with a backslash', '[["a","http://a/\\\\"]]', S, false],
	['a url with a space', one('a', 'http://a/ b'), S, false],
	['a url with a non-ASCII character', one('a', 'http://a/é'), S, false],
	['a url with an escaped NUL', '[["a","http://a/\\u0000"]]', S, false],
	['an ftp url', one('a', 'ftp://a/'), S, false],
	['a javascript url', one('a', 'javascript:alert(1)'), S, false],
	['a scheme alone', one('a', 'http://'), S, false],
	['an upper-case scheme', one('a', 'HTTP://a/'), S, false],
	['a url of 512 bytes', one('a', emojiUrl(512)), S, true],
	['a url of 513 bytes', one('a', emojiUrl(513)), S, false],
	['64 entries', ok(Array.from({ length: MAX_EMOJIS }, (_, i) => [shortcode(2, i), 'http://a/'])), S, true],
	['65 entries', ok(Array.from({ length: MAX_EMOJIS + 1 }, (_, i) => [shortcode(2, i), 'http://a/'])), S, false],
	['a status snapshot at its presented bound', ok(statusAtCap()), S, true],
	['a status snapshot a byte past it', ok(statusAtCap(true)), S, false],
	['short names at the presented bound', ok(statusShortNames()), S, true],
	['short names a byte past it', ok(statusShortNames(true)), S, false],
	['an account snapshot at its presented bound', ok(accountAtCap()), A, true],
	['an account snapshot a byte past it', ok(accountAtCap(true)), A, false],
	['a status snapshot under the account bound', ok(statusAtCap()), A, false],
	['padded to the stored bound', padded(statusAtCap(), S), S, true],
	['padded a byte past it', padded(statusAtCap(), S + 1), S, false],
	['an account snapshot padded to its bound', padded(accountAtCap(), A), A, true],
	['an account snapshot padded past it', padded(accountAtCap(), A + 1), A, false],
	['escaped names at the stored bound', escaped(statusAtCap().slice(0, 5), S), S, true],
	['escaped names a byte past it', escaped(statusAtCap().slice(0, 5), S + 1), S, false],
	['a maximal entry under the account bound', ok([maximalEntry(0)]), A, true],
]

describe('the emoji snapshot predicate and its JS twin (RES-2)', () => {
	it('measure the recipes in their units', () => {
		expect(presentedEmojiBytes(statusAtCap())).toBe(S)
		expect(presentedEmojiBytes(statusAtCap(true))).toBe(S + 1)
		expect(presentedEmojiBytes(statusShortNames())).toBe(S)
		expect(presentedEmojiBytes(statusShortNames(true))).toBe(S + 1)
		expect(presentedEmojiBytes(accountAtCap())).toBe(A)
		expect(presentedEmojiBytes(accountAtCap(true))).toBe(A + 1)
		// The presented size is the JSON of the entity's entries, which need no escapes.
		const entities = statusAtCap().map(([shortcode, url]) => ({
			shortcode,
			url,
			static_url: url,
			visible_in_picker: true,
		}))
		expect(new TextEncoder().encode(JSON.stringify(entities)).length).toBe(S)
		expect(new TextEncoder().encode(padded(statusAtCap(), S)).length).toBe(S)
		expect(new TextEncoder().encode(escaped(statusAtCap().slice(0, 5), S)).length).toBe(S)
	})

	it('give the expected verdict for every case', async () => {
		const sqlVerdicts = await runInDurableObject(freshStore(), (_instance, state) =>
			CASES.map(
				([, text, bound]) =>
					state.storage.sql.exec<{ past: number }>(`SELECT ${emojisPastBoundSql('?1', bound)} AS past`, text).one().past
			)
		)
		const verdicts = CASES.map(([name, text, bound], i) => [name, emojisValid(text, bound), sqlVerdicts[i] === 0])
		expect(verdicts).toEqual(CASES.map(([name, , , valid]) => [name, valid, valid]))
	})

	// A NUL after a complete value, written as the dump format writes such text (CAST(X'..' AS TEXT)): SQLite's JSON
	// functions stop at the NUL and see one valid pair.
	it('refuse a raw NUL after a complete value, as an import writes it', async () => {
		const hex = [...new TextEncoder().encode('[["a","http://a/"]]\u0000junk')]
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('')
		const seen = await runInDurableObject(freshStore(), (_instance, state) => {
			const value = `CAST(X'${hex}' AS TEXT)`
			return state.storage.sql
				.exec<{ past: number; valid: number; n: number }>(
					`SELECT ${emojisPastBoundSql(value, S)} AS past, json_valid(${value}) AS valid,
						json_array_length(${value}) AS n`
				)
				.one()
		})
		expect(seen).toEqual({ past: 1, valid: 1, n: 1 })
	})

	it('take NULL as no emoji, and refuse a value that is not text', async () => {
		expect(emojisValid(null, S)).toBe(true)
		const past = await runInDurableObject(freshStore(), (_instance, state) =>
			[null, new Uint8Array(new TextEncoder().encode(one('a'))), 1].map(
				(value) =>
					state.storage.sql.exec<{ past: number }>(`SELECT ${emojisPastBoundSql('?1', S)} AS past`, value).one().past
			)
		)
		expect(past).toEqual([0, 1, 1])
	})
})
