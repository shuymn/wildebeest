import { describe, expect, it } from 'vitest'

// worker -> app/jobs -> {mastodon, federation, web} -> domain -> {db, platform, security}  (design §4)
// A module may import its own layer or any lower one. Top-level files (worker.ts, store.ts, version.ts) are the
// entry tier. Durable Object features (cloudflare:*) belong to platform and the entry tier only.
const RANK: Record<string, number> = {
	worker: 0,
	app: 1,
	jobs: 1,
	mastodon: 2,
	federation: 2,
	web: 2,
	domain: 3,
	db: 4,
	platform: 4,
	security: 4,
}
const PLATFORM_MODULE_LAYERS = new Set(['worker', 'platform'])

const sources = import.meta.glob<string>(['../src/**/*.ts', '!../src/**/*.d.ts'], {
	query: '?raw',
	import: 'default',
	eager: true,
})

// `import ... from '...'`, `export ... from '...'`, `import '...'`, and `import('...')`.
const IMPORT =
	/(?:^|\n)\s*(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g

function layerOf(file: string): string {
	const parts = file.replace(/^\.\.\/src\//, '').split('/')
	return parts.length === 1 ? 'worker' : (parts[0] ?? '')
}

function resolve(from: string, specifier: string): string {
	const parts = from.split('/').slice(0, -1)
	for (const part of specifier.split('/')) {
		if (part === '..') {
			parts.pop()
		} else if (part !== '.') {
			parts.push(part)
		}
	}
	return parts.join('/')
}

function violations(files: Record<string, string>): string[] {
	const found: string[] = []
	for (const [file, source] of Object.entries(files)) {
		const from = layerOf(file)
		if (RANK[from] === undefined) {
			found.push(`${file}: directory is not part of the layering`)
			continue
		}
		for (const match of source.matchAll(IMPORT)) {
			const specifier = match[1] ?? match[2] ?? match[3] ?? ''
			if (specifier.startsWith('cloudflare:') && !PLATFORM_MODULE_LAYERS.has(from)) {
				found.push(`${file}: ${from} imports ${specifier}`)
			}
			if (!specifier.startsWith('.')) {
				continue
			}
			const target = resolve(file, specifier)
			if (!target.startsWith('../src/')) {
				continue
			}
			const to = layerOf(target)
			const allowed = to === from || (RANK[to] ?? -1) > (RANK[from] ?? Infinity)
			if (!allowed) {
				found.push(`${file}: ${from} imports ${to} (${specifier})`)
			}
		}
	}
	return found
}

describe('module layering', () => {
	it('sees the source tree', () => {
		expect(Object.keys(sources)).toEqual(expect.arrayContaining(['../src/worker.ts', '../src/domain/ids.ts']))
	})

	it('has no upward, sideways, or platform-leaking imports', () => {
		expect(violations(sources)).toEqual([])
	})

	it('detects violations', () => {
		expect(
			violations({
				'../src/domain/a.ts': "import { x } from '../app/app'\nimport { DurableObject } from 'cloudflare:workers'",
				'../src/mastodon/b.ts': "export { y } from '../federation/spool'",
				'../src/db/c.ts': "export type X = string\nconst m = await import('../platform/config')",
				'../src/security/e.ts': "import '../domain/ids'",
				'../src/stray/d.ts': '',
			})
		).toEqual([
			'../src/domain/a.ts: domain imports app (../app/app)',
			'../src/domain/a.ts: domain imports cloudflare:workers',
			'../src/mastodon/b.ts: mastodon imports federation (../federation/spool)',
			'../src/db/c.ts: db imports platform (../platform/config)',
			'../src/security/e.ts: security imports domain (../domain/ids)',
			'../src/stray/d.ts: directory is not part of the layering',
		])
	})
})
