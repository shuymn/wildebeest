import { describe, expect, it } from 'vitest'

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

const sources = import.meta.glob<string>(['../src/**/*.ts', '!../src/**/*.d.ts'], {
	query: '?raw',
	import: 'default',
	eager: true,
})

function violations(files: Record<string, string>): string[] {
	const found: string[] = []
	for (const [file, source] of Object.entries(files)) {
		for (const [pattern, what] of FORBIDDEN) {
			if (pattern.test(source)) {
				found.push(`${file}: uses ${what}`)
			}
		}
	}
	return found
}

describe('Fedify usage', () => {
	it('sees the federation sources', () => {
		expect(Object.keys(sources)).toContain('../src/federation/federation.ts')
	})

	it('never sends or queues through Fedify', () => {
		expect(violations(sources)).toEqual([])
	})

	// A relayed revocation is applied on the author's proof (federation/author-proof.ts): Fedify's LD-signature and object
	// proof verifiers run there only, against a key the author's own document embeds, and nowhere else decides on them.
	it('verifies author proofs in author-proof.ts only', () => {
		const verifying = Object.entries(sources)
			.filter(([, source]) => /\b(verifyJsonLd|verifyObject|verifyProof|verifySignature)\b/.test(source))
			.map(([file]) => file)
		expect(verifying).toEqual(['../src/federation/author-proof.ts'])
	})

	// Kopje's own LD signatures (a stamp's Delete) are made in ld-sign.ts only, with the preloaded contexts and a key
	// unwrapped for the call (DATA-1).
	it('signs Linked Data in ld-sign.ts only', () => {
		const signing = Object.entries(sources)
			.filter(([, source]) => /\b(signJsonLd|signObject)\b/.test(source))
			.map(([file]) => file)
		expect(signing).toEqual(['../src/federation/ld-sign.ts'])
	})

	it('detects each forbidden use', () => {
		expect(
			violations({
				'a.ts': 'await ctx.sendActivity({ identifier }, recipient, activity)',
				'b.ts': 'await ctx.forwardActivity(sender, "followers")',
				'c.ts': 'federation.startQueue(data)',
				'd.ts': "import { InProcessMessageQueue } from '@fedify/fedify'",
				'e.ts': "import { WorkersMessageQueue } from '@fedify/cfworkers'",
				'f.ts': 'createFederation<State>({ kv, queue: mq })',
			})
		).toEqual([
			'a.ts: uses sendActivity',
			'b.ts: uses forwardActivity',
			'c.ts: uses Fedify queue processing',
			'd.ts: uses a Fedify message queue',
			'e.ts: uses a Fedify message queue',
			'e.ts: uses a Fedify message queue',
			'f.ts: uses a Fedify message queue',
		])
	})
})
