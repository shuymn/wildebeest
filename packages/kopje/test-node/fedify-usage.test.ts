import { describe, expect, it } from 'vitest'

import { guardFixtures, parse, sources, type Source } from './source-scan.js'

// Outbound delivery goes through the deliveries table (design §4, §7), never through Fedify: its queue carries private
// keys in plain JWK, enqueues after the Store commit, and loses order. So the sources must not send with Fedify, give
// it a queue, or run its queue.
const FORBIDDEN: [RegExp, string][] = [
	[/\.sendActivity\s*\(/, 'sendActivity'],
	[/\.forwardActivity\s*\(/, 'forwardActivity'],
	[/\.(startQueue|processQueuedTask)\s*\(/, 'Fedify queue processing'],
	[/\b(InProcessMessageQueue|ParallelMessageQueue|WorkersMessageQueue)\b/, 'a Fedify message queue'],
	[/@fedify\/cfworkers/, 'a Fedify message queue'],
	[/createFederation(Builder)?\s*(<[^>]*>)?\s*\(\s*\{[^}]*\bqueue\s*:/s, 'a Fedify message queue'],
]

const SOURCES = sources('src', ['.ts'])

function violations(files: readonly Source[]): string[] {
	const found: string[] = []
	for (const source of files) {
		const { code } = parse(source)
		for (const [pattern, what] of FORBIDDEN) {
			if (pattern.test(code)) {
				found.push(`${source.path}: uses ${what}`)
			}
		}
	}
	return found
}

// The files whose code names one of `names`.
const naming = (files: readonly Source[], names: RegExp) =>
	files.filter((source) => names.test(parse(source).code)).map((source) => source.path)

// A relayed revocation is applied on the author's proof (federation/author-proof.ts): Fedify's LD-signature and object
// proof verifiers run there only, against a key the author's own document embeds, and nowhere else decides on them.
const VERIFIERS = /\b(verifyJsonLd|verifyObject|verifyProof|verifySignature)\b/
// Kopje's own LD signatures (a stamp's Delete) are made in ld-sign.ts only, with the preloaded contexts and a key
// unwrapped for the call (DATA-1).
const SIGNERS = /\b(signJsonLd|signObject)\b/

describe('Fedify usage', () => {
	it('sees the federation sources', () => {
		expect(SOURCES.map((s) => s.path)).toContain('src/federation/federation.ts')
	})

	it('never sends or queues through Fedify', () => {
		expect(violations(SOURCES)).toEqual([])
	})

	it('verifies author proofs in author-proof.ts only', () => {
		expect(naming(SOURCES, VERIFIERS)).toEqual(['src/federation/author-proof.ts'])
	})

	it('signs Linked Data in ld-sign.ts only', () => {
		expect(naming(SOURCES, SIGNERS)).toEqual(['src/federation/ld-sign.ts'])
	})

	it('detects each forbidden use', () => {
		const files = Object.entries({
			'a.ts': 'await ctx.sendActivity({ identifier }, recipient, activity)',
			'b.ts': 'await ctx.forwardActivity(sender, "followers")',
			'c.ts': 'federation.startQueue(data)',
			'd.ts': "import { InProcessMessageQueue } from '@fedify/fedify'",
			'e.ts': "import { WorkersMessageQueue } from '@fedify/cfworkers'",
			'f.ts': 'createFederation<State>({ kv, queue: mq })',
		}).map(([path, text]) => ({ path, text }))
		expect(violations(files)).toEqual([
			'a.ts: uses sendActivity',
			'b.ts: uses forwardActivity',
			'c.ts: uses Fedify queue processing',
			'd.ts: uses a Fedify message queue',
			'e.ts: uses a Fedify message queue',
			'e.ts: uses a Fedify message queue',
			'f.ts: uses a Fedify message queue',
		])
	})

	const find = (files: readonly Source[]) => [
		...violations(files),
		...naming(files, VERIFIERS).map((path) => `${path} verifies`),
		...naming(files, SIGNERS).map((path) => `${path} signs`),
	]
	guardFixtures(find, {
		flagged: {
			'a verifier outside author-proof.ts': [
				"import { verifyObject } from '@fedify/fedify'",
				'src/domain/probe.ts verifies',
			],
			'a signer outside ld-sign.ts': ['const signed = await signJsonLd(doc, key, id)', 'src/domain/probe.ts signs'],
		},
		passed: {
			'names in comments': '// ctx.sendActivity(...), createFederation({ queue: q }), verifyObject, signJsonLd\nf()',
			'a queue outside createFederation': 'const options = { queue: q }\ncreateFederation({ kv })',
		},
	})
})
