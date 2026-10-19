import { describe, expect, it } from 'vitest'

import {
	covers,
	type ParamEvidence,
	paramFailures,
	type Read,
	unresolvedFailures,
} from '../test/mastodon-conformance.js'

// The comparison logic of the Mastodon conformance checks, on hand-made evidence: what counts as a read of a name,
// and which failures a route's evidence gives.

const evidence = (overrides: Partial<ParamEvidence> & { reads?: Record<string, Read[]> }): ParamEvidence => ({
	names: ['a', 'b'],
	unresolved: [],
	exceptions: undefined,
	acknowledged: undefined,
	...overrides,
	observation: overrides.observation ?? {
		baseline: { ok: true },
		reads: new Map(Object.entries(overrides.reads ?? {})),
	},
})

describe('the coverage rule', () => {
	it('takes each accessor for the names it returns', () => {
		expect(covers({ method: 'get', name: 'a' }, 'a')).toBe(true)
		expect(covers({ method: 'get', name: 'a' }, 'a[]')).toBe(false)
		expect(covers({ method: 'query', name: 'acct' }, 'acct')).toBe(true)
		expect(covers({ method: 'file', name: 'avatar' }, 'avatar')).toBe(true)
		for (const method of ['has', 'getAll'] as const) {
			expect(covers({ method, name: 'id' }, 'id')).toBe(true)
			expect(covers({ method, name: 'id' }, 'id[]')).toBe(true)
		}
		expect(covers({ method: 'list', name: 'types' }, 'types[]')).toBe(true)
		expect(covers({ method: 'list', name: 'types' }, 'types')).toBe(false)
		expect(covers({ method: 'objects', name: 'fields_attributes' }, 'fields_attributes[][name]')).toBe(true)
		expect(covers({ method: 'objects', name: 'fields_attributes' }, 'fields_attributes[0][value]')).toBe(true)
		expect(covers({ method: 'objects', name: 'fields_attributes' }, 'fields_attributes[name]')).toBe(false)
		expect(covers({ method: 'objects', name: 'fields' }, 'fields_attributes[][name]')).toBe(false)
	})

	it('takes a container read for no leaf: hasObject alone does not read poll[expires_in]', () => {
		expect(covers({ method: 'hasObject', name: 'poll' }, 'poll[expires_in]')).toBe(false)
		const reads = { 'poll[expires_in]': [{ method: 'hasObject', name: 'poll' }] } satisfies Record<string, Read[]>
		expect(paramFailures(evidence({ names: ['poll[expires_in]'], reads }))).toEqual([
			'poll[expires_in]: Mastodon reads it, Kopje does not (read it, or add an exception)',
		])
	})
})

describe('paramFailures', () => {
	const open = { status: 'open', issue: 1142, note: 'gap' } as const

	it('passes a route whose every name is read, and fails one not read', () => {
		const a = [{ method: 'get', name: 'a' }] satisfies Read[]
		expect(paramFailures(evidence({ reads: { a, b: [{ method: 'get', name: 'b' }] } }))).toEqual([])
		expect(paramFailures(evidence({ reads: { a, b: a } }))).toEqual([
			'b: Mastodon reads it, Kopje does not (read it, or add an exception)',
		])
	})

	it('counts a read only in the request that sent the name', () => {
		// b was read while a was sent, never while b was.
		expect(paramFailures(evidence({ reads: { a: [{ method: 'get', name: 'b' }], b: [] } }))).toEqual([
			'a: Mastodon reads it, Kopje does not (read it, or add an exception)',
			'b: Mastodon reads it, Kopje does not (read it, or add an exception)',
		])
	})

	it('passes a name an exception lists, and fails an exception that no longer applies', () => {
		const reads = { a: [{ method: 'get', name: 'a' }], b: [] } satisfies Record<string, Read[]>
		expect(paramFailures(evidence({ reads, exceptions: { b: open } }))).toEqual([])
		expect(paramFailures(evidence({ reads, exceptions: { a: open, b: open } }))).toEqual([
			'a: read now; remove its exception',
		])
		expect(paramFailures(evidence({ reads, exceptions: { b: open, gone: open } }))).toEqual([
			"gone: not a parameter of the fixture's route; remove its exception",
		])
	})

	it('reports a baseline that did not answer as expected as a setup failure only', () => {
		const observation = { baseline: { ok: false, detail: '404 Record not found' }, reads: new Map() } as const
		expect(paramFailures(evidence({ observation }))).toEqual([
			'setup: the baseline request failed (404 Record not found)',
		])
	})

	it('fails unresolved extraction unless acknowledged with exactly its reasons', () => {
		const reads = { a: [{ method: 'get', name: 'a' }], b: [{ method: 'get', name: 'b' }] } satisfies Record<
			string,
			Read[]
		>
		const unresolved = ['x.rb m: params used whole `params`']
		expect(paramFailures(evidence({ reads, unresolved }))).toHaveLength(1)
		expect(paramFailures(evidence({ reads, unresolved, acknowledged: unresolved }))).toEqual([])
		expect(unresolvedFailures(unresolved, ['x.rb m: an older reason'])).toHaveLength(1)
		expect(unresolvedFailures([], unresolved)).toHaveLength(1)
		expect(unresolvedFailures([], undefined)).toEqual([])
	})
})
