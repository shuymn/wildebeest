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
