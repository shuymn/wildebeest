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

// Where an unchecked local key (getLocalKey) can be loaded or used for signing: only userSigner calls .localKey(, and
// only setKeyPairsDispatcher calls userSigner.
function keyLoadingViolations(files: Record<string, string>): string[] {
	const found: string[] = []
	const FED = '../src/federation/federation.ts'
	for (const [file, source] of Object.entries(files)) {
		const outside = file === FED ? source.replace(/const userSigner = async[\s\S]*?\n\t\}\n/, '') : source
		if (/\.localKey\s*\(/.test(outside)) {
			found.push(`${file}: calls .localKey( outside userSigner`)
		}
		const calls = source.match(/\buserSigner\s*\(/g)?.length ?? 0
		const inDispatcher = /setKeyPairsDispatcher\([\s\S]*?\buserSigner\s*\(identifier\)/.test(source) ? 1 : 0
		if (calls > inDispatcher) {
			found.push(`${file}: calls userSigner outside setKeyPairsDispatcher`)
		}
		if (/\b(getDocumentLoader|getActorKeyPairs|setInboxListeners)\s*\(/.test(source)) {
			found.push(`${file}: asks Fedify to sign with the dispatcher keys`)
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

	// A fetch signed as a local account loads its key through getSigningKey (localSigner), or getFollowerKey for a
	// follower, both of which refuse an unavailable account. getLocalKey has no such check and serves only Fedify's
	// key-pairs dispatcher (userSigner), so nothing may make Fedify sign with those pairs: no document loader or key
	// pairs asked of Fedify, and no Fedify inbox listeners, whose loader signs as the recipient.
	it('loads a local key without the availability check only for the key-pairs dispatcher', () => {
		expect(keyLoadingViolations(sources)).toEqual([])
	})

	it('detects each unchecked key use', () => {
		const userSigner = `const userSigner = async (username) => {
		const key = await rpc((s) => s.localKey(build, { username }))
	}
	federation.setKeyPairsDispatcher(async (_ctx, identifier) => { await userSigner(identifier) })`
		const fed = '../src/federation/federation.ts'
		expect(keyLoadingViolations({ [fed]: userSigner })).toEqual([])
		expect(
			keyLoadingViolations({
				[fed]: userSigner.replace('{ await userSigner(identifier) }', '{}') + '\nawait userSigner(name)',
			})
		).toEqual([`${fed}: calls userSigner outside setKeyPairsDispatcher`])
		expect(keyLoadingViolations({ [fed]: `${userSigner}\nconst localSigner = () => s.localKey(build, x)` })).toEqual([
			`${fed}: calls .localKey( outside userSigner`,
		])
		expect(keyLoadingViolations({ [fed]: userSigner, 'a.ts': 'store.localKey(build, x)' })).toEqual([
			'a.ts: calls .localKey( outside userSigner',
		])
		expect(
			keyLoadingViolations({
				[fed]: userSigner,
				'b.ts': 'ctx.getDocumentLoader({ identifier })',
				'c.ts': 'ctx.getActorKeyPairs(name)',
				'd.ts': 'federation.setInboxListeners("/u/{identifier}/inbox")',
			})
		).toEqual([
			'b.ts: asks Fedify to sign with the dispatcher keys',
			'c.ts: asks Fedify to sign with the dispatcher keys',
			'd.ts: asks Fedify to sign with the dispatcher keys',
		])
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
