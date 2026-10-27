import { describe, expect, it } from 'vitest'

import { guardFixtures, parse, resolve, sources, walk, type Source } from './source-scan.js'

// worker -> app/jobs -> {mastodon, federation, web} -> domain -> {db, platform, security}  (design §4)
// A module may import its own layer or any lower one. Top-level files (worker.ts, store.ts, version.ts) are the
// entry tier. Durable Object features (cloudflare:*) belong to platform and the entry tier only. src/client is the
// browser's L1 bundle (design §7.2), a program of its own: it imports only its own modules, and nothing imports it
// (having no rank, it is neither above nor below any layer).
const CLIENT = 'client'
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

const SOURCES = sources('src')

function layerOf(file: string): string {
	const parts = file.replace(/^src\//, '').split('/')
	return parts.length === 1 ? 'worker' : (parts[0] ?? '')
}

// The specifiers a module imports: import and export declarations, import() and import types. An import() whose
// specifier is not a string literal is null: its layer cannot be read.
function specifiers(source: Source): (string | null)[] {
	const found: (string | null)[] = []
	walk(parse(source).program, (node) => {
		if (
			node.type === 'ImportDeclaration' ||
			node.type === 'ExportAllDeclaration' ||
			node.type === 'TSImportType' ||
			(node.type === 'ExportNamedDeclaration' && node.source !== null)
		) {
			found.push(node.source?.value ?? null)
		} else if (node.type === 'ImportExpression') {
			found.push(node.source.type === 'Literal' && typeof node.source.value === 'string' ? node.source.value : null)
		}
	})
	return found
}

function violations(files: readonly Source[]): string[] {
	const found: string[] = []
	for (const source of files) {
		const file = source.path
		const from = layerOf(file)
		if (from !== CLIENT && RANK[from] === undefined) {
			found.push(`${file}: directory is not part of the layering`)
			continue
		}
		for (const specifier of specifiers(source)) {
			if (specifier === null) {
				found.push(`${file}: imports a computed specifier`)
				continue
			}
			if (specifier.startsWith('cloudflare:') && !PLATFORM_MODULE_LAYERS.has(from)) {
				found.push(`${file}: ${from} imports ${specifier}`)
			}
			if (!specifier.startsWith('.')) {
				if (from === CLIENT) {
					found.push(`${file}: client imports ${specifier}`)
				}
				continue
			}
			const target = resolve(file, specifier)
			if (!target.startsWith('src/')) {
				if (from === CLIENT) {
					found.push(`${file}: client imports ${specifier}`)
				}
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
		expect(SOURCES.map((s) => s.path)).toEqual(expect.arrayContaining(['src/worker.ts', 'src/domain/ids.ts']))
	})

	it('has no upward, sideways, or platform-leaking imports', () => {
		expect(violations(SOURCES)).toEqual([])
	})

	it('detects violations', () => {
		expect(
			violations([
				{
					path: 'src/domain/a.ts',
					text: "import { x } from '../app/app'\nimport { DurableObject } from 'cloudflare:workers'",
				},
				{ path: 'src/mastodon/b.ts', text: "export { y } from '../federation/spool'" },
				{ path: 'src/db/c.ts', text: "export type X = string\nconst m = await import('../platform/config')" },
				{ path: 'src/security/e.ts', text: "import '../domain/ids'" },
				{ path: 'src/stray/d.ts', text: '' },
				{
					path: 'src/client/f.ts',
					text: "import { g } from './g'\nimport { h } from '../web/format'\nimport 'zod'\nimport '../../scripts/x'",
				},
				{ path: 'src/web/i.ts', text: "import { f } from '../client/f'" },
			])
		).toEqual([
			'src/domain/a.ts: domain imports app (../app/app)',
			'src/domain/a.ts: domain imports cloudflare:workers',
			'src/mastodon/b.ts: mastodon imports federation (../federation/spool)',
			'src/db/c.ts: db imports platform (../platform/config)',
			'src/security/e.ts: security imports domain (../domain/ids)',
			'src/stray/d.ts: directory is not part of the layering',
			'src/client/f.ts: client imports web (../web/format)',
			'src/client/f.ts: client imports zod',
			'src/client/f.ts: client imports ../../scripts/x',
			'src/web/i.ts: web imports client (../client/f)',
		])
	})

	guardFixtures(violations, {
		flagged: {
			'an export of everything': ["export * from '../app/app'", 'src/domain/probe.ts: domain imports app (../app/app)'],
			'an import type': [
				"type T = import('../web/pages').Page",
				'src/domain/probe.ts: domain imports web (../web/pages)',
			],
			'a computed import()': [
				'const m = await import(`../app/${name}`)',
				'src/domain/probe.ts: imports a computed specifier',
			],
		},
		passed: {
			'its own layer, a lower one and a package':
				"import { a } from './ids'\nimport { b } from '../db/sql'\nimport { z } from 'zod'",
			'an import in a comment': "// import { x } from '../app/app'\nconst s = \"import '../app/app'\"",
		},
	})
})

// R32 (docs/visibility.md): a streaming delete is captured (streamDelete in src/domain/streaming.ts) once, before the
// first change to the status's audience, at exactly four sites; none runs under a batch's budget (JobBudget, RowBudget),
// and a status's boosts removed inside batches are covered by the original's capture. A remote boost's removal
// (removeBoost, from deleteObject and undoInteraction) captures before it hides or deletes the boost.
const SITES: readonly [file: string, name: string, changes: readonly string[]][] = [
	[
		'src/domain/statuses.ts',
		'deleteStatus',
		['removeReblog(', 'beginRetraction(', 'UPDATE statuses SET withdrawn', 'UPDATE media_attachments'],
	],
	['src/domain/statuses.ts', 'unreblog', ['removeReblog(']],
	['src/domain/inbox.ts', 'deleteObject', ['runJobBatch(']],
	['src/domain/inbox.ts', 'removeBoost', ['hideRemoteStatus(', 'DELETE FROM statuses']],
]

// The code (comments blanked) of the top-level function or const `name` of `file`.
function body(files: readonly Source[], file: string, name: string): string | undefined {
	const source = files.find((s) => s.path === file)
	if (source === undefined) {
		return undefined
	}
	const { program, code } = parse(source)
	for (const statement of program.body) {
		const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
		const named =
			(declaration?.type === 'FunctionDeclaration' && declaration.id?.name === name) ||
			(declaration?.type === 'VariableDeclaration' &&
				declaration.declarations.some((d) => d.id.type === 'Identifier' && d.id.name === name))
		if (named) {
			return code.slice(statement.start, statement.end)
		}
	}
	return undefined
}

function captureProblems(files: readonly Source[]): string[] {
	const found: string[] = []
	for (const [file, name, changes] of SITES) {
		const text = body(files, file, name)
		if (text === undefined) {
			found.push(`${file} has no ${name}`)
			continue
		}
		const capture = text.indexOf('streamDelete(')
		if (capture === -1) {
			found.push(`${name} does not capture`)
		}
		for (const change of changes) {
			const at = text.indexOf(change)
			if (at === -1) {
				found.push(`${name} has no ${change}`)
			} else if (capture > at) {
				found.push(`${name} captures after ${change}`)
			}
		}
		if (/\b(?:Job|Row)?Budget\b/.test(text)) {
			found.push(`${name} runs under a budget`)
		}
	}
	// A remote status's delete is captured only when its job is created: the job row is the persisted marker.
	const created =
		/const created = db\.first\(\s*`INSERT INTO inbound_jobs[^`]*ON CONFLICT DO NOTHING\s*RETURNING key`[^]*?if \(created !== undefined\) \{\s*streamDelete\(/
	if (!created.test(body(files, 'src/domain/inbox.ts', 'deleteObject') ?? '')) {
		found.push('deleteObject captures other than when its job is created')
	}
	const calls = files.flatMap((source) => [...parse(source).code.matchAll(/\bstreamDelete\(/g)].map(() => source.path))
	const expected = [
		'src/domain/inbox.ts',
		'src/domain/inbox.ts',
		'src/domain/statuses.ts',
		'src/domain/statuses.ts',
		// Its declaration.
		'src/domain/streaming.ts',
	]
	if (calls.sort().join() !== expected.join()) {
		found.push(`streamDelete is named at ${calls.join(', ')}`)
	}
	return found
}

describe('the streaming delete capture sites', () => {
	it('captures at the four sites, before the audience changes, and nowhere else', () => {
		expect(captureProblems(SOURCES)).toEqual([])
	})

	// Each fixture is inbox.ts as it is, edited, among the real sources.
	const inbox = SOURCES.find((s) => s.path === 'src/domain/inbox.ts')?.text ?? ''
	const BOOST = '\tstreamDelete(db, boost.id, now)\n\tconst boosted ='
	expect(inbox).toContain(BOOST)
	const ON_CREATE =
		'\tif (created !== undefined) {\n\t\tstreamDelete(db, status.id, now)\n\t\thideRemoteStatus(db, status.id)\n\t}'
	expect(inbox).toContain(ON_CREATE)
	guardFixtures(
		captureProblems,
		{
			flagged: {
				'a capture in a comment only': [
					inbox.replace(BOOST, '\t// streamDelete(db, boost.id, now)\n\tconst boosted ='),
					'removeBoost does not capture',
				],
				'a capture after the change': [
					inbox
						.replace(BOOST, '\tconst boosted =')
						.replace(
							'\trecountStatus(db, boost.original)',
							'\tstreamDelete(db, boost.id, now)\n\trecountStatus(db, boost.original)'
						),
					'removeBoost captures after hideRemoteStatus(',
				],
				'a capture under a JobBudget': [
					inbox.replace('function removeBoost(\n\tdb: Db,', 'function removeBoost(\n\tbudget: JobBudget,\n\tdb: Db,'),
					'removeBoost runs under a budget',
				],
				'a capture under a RowBudget': [
					inbox.replace('function removeBoost(\n\tdb: Db,', 'function removeBoost(\n\tbudget: RowBudget,\n\tdb: Db,'),
					'removeBoost runs under a budget',
				],
				'a capture outside the job creation': [
					inbox.replace(
						ON_CREATE,
						'\tstreamDelete(db, status.id, now)\n\tif (created !== undefined) {\n\t\thideRemoteStatus(db, status.id)\n\t}'
					),
					'deleteObject captures other than when its job is created',
				],
				'a fifth site': [
					`${inbox}\nfunction extra(db: Db): void {\n\tstreamDelete(db, 'x', 0)\n}\n`,
					`streamDelete is named at ${['inbox', 'inbox', 'inbox', 'statuses', 'statuses', 'streaming'].map((m) => `src/domain/${m}.ts`).join(', ')}`,
				],
			},
			passed: { 'a capture named in a comment': `${inbox}\n// streamDelete(db, id, now) runs above.\n` },
		},
		{ path: 'src/domain/inbox.ts', over: SOURCES }
	)
})
