import { describe, expect, it } from 'vitest'

import {
	API_BODY_LIMIT,
	bodyLimit,
	MAX_PARAM_DEPTH,
	MAX_PARAM_PATHS,
	PARAM_PATH_BUDGET,
	Params,
	type ReadOptions,
	readParams,
} from '../src/mastodon/params'

describe('Params#objects', () => {
	it('reads indexed (JSON) and sequential (form) objects', () => {
		const p = new Params([
			['media_attributes[1][id]', 'b'],
			['media_attributes[0][id]', 'a'],
			['media_attributes[0][description]', 'A'],
			['media_attributes[][id]', 'c'],
			['media_attributes[][description]', 'C'],
			['media_attributes[][id]', 'd'],
		])
		expect(p.objects('media_attributes')).toEqual([
			{ id: 'a', description: 'A' },
			{ id: 'b' },
			{ id: 'c', description: 'C' },
			{ id: 'd' },
		])
	})

	it('matches the name literally, regex metacharacters included', () => {
		const p = new Params([
			['a.b[0][id]', 'literal'],
			['axb[0][id]', 'wildcard'],
			['a\\b[0][id]', 'backslash'],
			['(x)[0][id]', 'group'],
		])
		expect(p.objects('a.b')).toEqual([{ id: 'literal' }])
		expect(p.objects('a\\b')).toEqual([{ id: 'backslash' }])
		expect(p.objects('(x)')).toEqual([{ id: 'group' }])
		expect(p.objects('.*')).toEqual([])
	})
})

const FILES = { names: ['avatar'], maxBytes: 64 }

function multipart(parts: [string, string | File][]): Request {
	const body = new FormData()
	for (const [name, value] of parts) {
		body.append(name, value)
	}
	return new Request('https://kopje.test/x', { method: 'POST', body })
}

function post(body: BodyInit, type: string, query = ''): Request {
	return new Request(`https://kopje.test/x${query}`, { method: 'POST', body, headers: { 'content-type': type } })
}

async function read(request: Request, options?: ReadOptions): Promise<Params> {
	const result = await readParams(request, options)
	if (!result.ok) {
		throw new Error(`refused ${result.status}`)
	}
	return result.params
}

const png = (name = 'a.png') => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })

describe('readParams: declared files (Rails last-part rule)', () => {
	it('chooses the last part of a declared name, text or file, and never both', async () => {
		const textLast = await read(
			multipart([
				['avatar', png()],
				['avatar', 'x'],
			]),
			{ files: FILES }
		)
		expect([textLast.get('avatar'), textLast.file('avatar')]).toEqual(['x', undefined])
		const fileLast = await read(
			multipart([
				['avatar', 'x'],
				['avatar', png('b.png')],
			]),
			{ files: FILES }
		)
		expect([fileLast.get('avatar'), fileLast.file('avatar')?.name]).toEqual([undefined, 'b.png'])
		const twoFiles = await read(
			multipart([
				['avatar', png('1.png')],
				['avatar', png('2.png')],
			]),
			{ files: FILES }
		)
		expect(twoFiles.file('avatar')?.name).toBe('2.png')
	})

	it('reads a part with an empty filename as text, as workerd parses it (Rack drops it)', async () => {
		const raw = (payload: string) =>
			post(
				`--b\r\nContent-Disposition: form-data; name="avatar"; filename=""\r\nContent-Type: image/png\r\n\r\n${payload}\r\n--b--\r\n`,
				'multipart/form-data; boundary=b'
			)
		const empty = await read(raw(''), { files: FILES })
		expect([empty.get('avatar'), empty.file('avatar')]).toEqual(['', undefined])
		const filled = await read(raw('abc'), { files: FILES })
		expect([filled.get('avatar'), filled.file('avatar')]).toEqual(['abc', undefined])
	})

	it('reads a query value of a declared name only when the body has none', async () => {
		const request = (query: string, parts: [string, string | File][]) => {
			const body = new FormData()
			for (const [name, value] of parts) {
				body.append(name, value)
			}
			return new Request(`https://kopje.test/x${query}`, { method: 'POST', body })
		}
		const bodyWins = await read(request('?avatar=q', [['avatar', png()]]), { files: FILES })
		expect([bodyWins.get('avatar'), bodyWins.file('avatar')?.name]).toEqual([undefined, 'a.png'])
		const queryOnly = await read(request('?avatar=q&avatar=r', [['note', 'n']]), { files: FILES })
		expect([queryOnly.get('avatar'), queryOnly.file('avatar')]).toEqual(['r', undefined])
	})

	it('ignores undeclared file parts and keeps first-wins text elsewhere', async () => {
		const p = await read(
			multipart([
				['thumbnail', png()],
				['note', 'a'],
				['note', 'b'],
			]),
			{ files: FILES }
		)
		expect([p.file('thumbnail'), p.get('thumbnail'), p.get('note')]).toEqual([undefined, undefined, 'a'])
	})
})

describe('readParams: body and text bounds', () => {
	it('bounds a body without a file rule at its limit, declared or streamed', async () => {
		const ok = 'a='.padEnd(API_BODY_LIMIT, 'x')
		expect((await readParams(post(ok, 'application/x-www-form-urlencoded'))).ok).toBe(true)
		expect(await readParams(post(`${ok}x`, 'application/x-www-form-urlencoded'))).toEqual({ ok: false, status: 413 })
		const streamed = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(`${ok}x`))
				controller.close()
			},
		})
		const request = new Request('https://kopje.test/x', {
			method: 'POST',
			body: streamed,
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			duplex: 'half',
		} as RequestInit)
		expect(await readParams(request)).toEqual({ ok: false, status: 413 })
	})

	it('lets a file route carry its files in multipart only', () => {
		const files = { names: ['avatar', 'header'], maxBytes: 8 * 1024 * 1024 }
		expect(bodyLimit('multipart/form-data; boundary=x', { files })).toBe(17_858_560)
		expect(bodyLimit('application/json', { files })).toBe(API_BODY_LIMIT)
		expect(bodyLimit('multipart/form-data; boundary=x')).toBe(API_BODY_LIMIT)
	})

	it('refuses multipart text past the limit in UTF-8 bytes, astral characters included', async () => {
		const limit = 64
		// 'a' and '=' are not counted as text: the entry is name 'a' (1 byte) and its value.
		const fits = await readParams(multipart([['a', '\u{1F600}'.repeat(15) + 'xyz']]), { limit: 1024, files: FILES })
		expect(fits.ok).toBe(true)
		const value = '\u{1F600}'.repeat(15) + 'xyz' // 63 bytes
		expect((await readParams(multipart([['a', value]]), { limit, files: FILES })).ok).toBe(true)
		expect(await readParams(multipart([['a', `${value}b`]]), { limit, files: FILES })).toEqual({
			ok: false,
			status: 413,
		})
		// The query counts too.
		const withQuery = new Request('https://kopje.test/x?q=1', {
			method: 'POST',
			body: (() => {
				const f = new FormData()
				f.append('a', value)
				return f
			})(),
		})
		expect(await readParams(withQuery, { limit, files: FILES })).toEqual({ ok: false, status: 413 })
	})
})

describe('readParams: JSON path expansion', () => {
	const json = (value: string) => post(value, 'application/json')

	it('refuses an empty-object amplification before building its keys', async () => {
		const parent = 'p'.repeat(32 * 1024)
		const children = Array.from({ length: 50_000 }, (_, i) => `"${i}":{}`).join(',')
		const body = `{"${parent}":{${children}}}`
		expect(body.length).toBeLessThan(API_BODY_LIMIT)
		expect(await readParams(json(body))).toEqual({ ok: false, status: 413 })
	})

	it('accepts MAX_PARAM_PATHS generated keys and refuses one more', async () => {
		// One key per member: the object `o` itself is a key, and each of its members.
		const members = (n: number) => Array.from({ length: n }, (_, i) => `"${i}":1`).join(',')
		expect((await readParams(json(`{"o":{${members(MAX_PARAM_PATHS - 1)}}}`))).ok).toBe(true)
		expect(await readParams(json(`{"o":{${members(MAX_PARAM_PATHS)}}}`))).toEqual({ ok: false, status: 413 })
	})

	it('counts a long list of scalars in code units only, so it is not refused for its length', async () => {
		const list = `{"context":[${Array.from({ length: 100_000 }, () => '"home"').join(',')}]}`
		expect((await readParams(json(list))).ok).toBe(true)
		// The same items under a long name pass the code-unit budget.
		const name = 'n'.repeat(1000)
		const amplified = `{"${name}":[${Array.from({ length: 3_000 }, () => '1').join(',')}]}`
		expect(await readParams(json(amplified))).toEqual({ ok: false, status: 413 })
	})

	it('refuses past PARAM_PATH_BUDGET code units', async () => {
		// Each member costs prefix (1) + key + 2 units; the top-level key `o` costs 0 + 1 + 2 = 3.
		const key = 'k'.repeat(1000)
		const per = 1 + 1000 + 2 + 4 // the key plus a 4-unit distinct suffix
		const n = Math.floor((PARAM_PATH_BUDGET - 3) / per)
		const members = (count: number) =>
			Array.from({ length: count }, (_, i) => `"${key}${String(i).padStart(4, '0')}":1`).join(',')
		const fits = await readParams(json(`{"o":{${members(n)}}}`), { limit: 4 * API_BODY_LIMIT })
		expect(fits.ok || fits.status).toBe(true)
		const over = await readParams(json(`{"o":{${members(n + 1)}}}`), { limit: 4 * API_BODY_LIMIT })
		expect(over).toEqual({ ok: false, status: 413 })
	})

	it(`accepts ${MAX_PARAM_DEPTH} levels of nesting and refuses ${MAX_PARAM_DEPTH + 1}`, async () => {
		const nested = (depth: number) => `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`
		expect((await readParams(json(nested(MAX_PARAM_DEPTH)))).ok).toBe(true)
		expect(await readParams(json(nested(MAX_PARAM_DEPTH + 1)))).toEqual({ ok: false, status: 400 })
	})

	it('counts an empty object as sent (sentObject), not as hasObject', async () => {
		const p = await read(json('{"home":{},"fields_attributes":{"0":{}},"poll":{}}'))
		expect(p.sentObject('home')).toBe(true)
		expect(p.sentObject('fields_attributes')).toBe(true)
		expect(p.hasObject('poll')).toBe(false)
		expect(p.sentObject('notifications')).toBe(false)
	})
})
