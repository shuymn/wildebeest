import type { Node } from 'oxc-parser'
import { describe, expect, it } from 'vitest'

import { guardFixtures, lineOf, parse, resolve, sources, walk, type Source } from './source-scan.js'

// The public pages' boundary (VIS-4): a page read and the public routes see no viewer. The
// page reads (src/domain/web-pages/) and the public routes (src/app/public-pages.tsx) import no credential,
// authorization, session or cookie module, take from the modules that also serve signed-in requests only what an
// anonymous read needs, and make a viewer context only for nobody (contextOf(null, …)). The web layer (src/web/) reads
// the Store only through a route: it imports neither the database nor the Store.

const ANONYMOUS = (path: string) => path.startsWith('src/domain/web-pages/') || path === 'src/app/public-pages.tsx'

// Modules an anonymous page never imports.
const FORBIDDEN = new Set([
	'src/domain/web-session',
	'src/web/session',
	'src/security/tokens',
	'src/security/scopes',
	'hono/cookie',
])

// Modules that also serve signed-in requests, and what an anonymous page may take from them.
const ALLOWED_NAMES: Record<string, readonly string[]> = {
	'src/domain/auth': ['contextOf', 'ViewerContext'],
	'src/mastodon/context': ['ApiDeps', 'present', 'storeCall'],
}

const WEB_FORBIDDEN = [/^src\/db\//, /^src\/store$/, /^src\/platform\/store-client$/]

// The name a specifier takes from its module: `*` for a namespace, `default` for a default import.
function specifierName(specifier: Node): string {
	switch (specifier.type) {
		case 'ImportNamespaceSpecifier':
			return '*'
		case 'ImportDefaultSpecifier':
			return 'default'
		case 'ImportSpecifier':
			return specifier.imported.type === 'Identifier' ? specifier.imported.name : String(specifier.imported.value)
		case 'ExportSpecifier':
			return specifier.local.type === 'Identifier' ? specifier.local.name : String(specifier.local.value)
		default:
			return '?'
	}
}

// What a module reference may bring into a guarded file: the rules on its target, for every form that names a module
// (an import or export declaration, an import() and an import type). `names` is what it takes by name, or null for
// the whole module.
function checkTarget(
	found: string[],
	at: string,
	from: { anonymous: boolean; web: boolean },
	target: string,
	names: readonly string[] | null
): void {
	if (from.web && WEB_FORBIDDEN.some((pattern) => pattern.test(target))) {
		found.push(`${at} imports ${target}`)
	}
	if (!from.anonymous) {
		return
	}
	if (FORBIDDEN.has(target)) {
		found.push(`${at} imports ${target}`)
	}
	const allowed = ALLOWED_NAMES[target]
	if (allowed === undefined) {
		return
	}
	if (names === null) {
		found.push(`${at} imports all of ${target}`)
		return
	}
	for (const name of names) {
		if (!allowed.includes(name)) {
			found.push(`${at} imports ${name} from ${target}`)
		}
	}
}

// The local name of an import specifier, when it differs from the name it imports (an alias).
function aliasOf(specifier: Node): string | null {
	return specifier.type === 'ImportSpecifier' &&
		specifier.local.name !==
			(specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value)
		? specifier.local.name
		: null
}

function violations(files: readonly Source[]): string[] {
	const found: string[] = []
	for (const source of files) {
		const file = source.path
		const from = { anonymous: ANONYMOUS(file), web: file.startsWith('src/web/') }
		if (!from.anonymous && !from.web) {
			continue
		}
		const targetOf = (specifier: string) =>
			(specifier.startsWith('.') ? resolve(file, specifier) : specifier).replace(/\.tsx?$/, '')
		walk(parse(source).program, (node) => {
			const at = `${file}:${lineOf(source.text, node.start)}`
			if (
				node.type === 'ImportDeclaration' ||
				node.type === 'ExportNamedDeclaration' ||
				node.type === 'ExportAllDeclaration'
			) {
				if (node.source === null || node.source === undefined) {
					return
				}
				const target = targetOf(String(node.source.value))
				const specifiers = 'specifiers' in node ? node.specifiers : []
				const whole = node.type === 'ExportAllDeclaration' || specifiers.length === 0
				checkTarget(found, at, from, target, whole ? null : specifiers.map(specifierName))
				// A guarded module's names keep their own: the call checks below read them by name.
				if (from.anonymous && ALLOWED_NAMES[target] !== undefined) {
					for (const alias of specifiers.flatMap((specifier) => aliasOf(specifier) ?? [])) {
						found.push(`${at} renames an import of ${target} as ${alias}`)
					}
				}
				return
			}
			if (node.type === 'ImportExpression') {
				if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
					checkTarget(found, at, from, targetOf(node.source.value), null)
				} else {
					found.push(`${at} imports a computed specifier`)
				}
				return
			}
			if (node.type === 'TSImportType') {
				const specifier = node.source.value
				const qualifier = node.qualifier
				const name = qualifier?.type === 'Identifier' ? qualifier.name : null
				checkTarget(found, at, from, targetOf(String(specifier)), name === null ? null : [name])
				return
			}
			if (
				from.anonymous &&
				node.type === 'CallExpression' &&
				node.callee.type === 'Identifier' &&
				node.callee.name === 'contextOf'
			) {
				const viewer = node.arguments[0]
				if (viewer?.type !== 'Literal' || viewer.value !== null) {
					found.push(`${at} makes a viewer context for someone`)
				}
			}
		})
	}
	return found
}

const SOURCES = sources('src')

describe('the public pages’ boundary (VIS-4)', () => {
	it('sees the page reads, the public routes and the web layer', () => {
		const paths = SOURCES.map((s) => s.path)
		expect(paths).toEqual(
			expect.arrayContaining(['src/domain/web-pages/site.ts', 'src/app/public-pages.tsx', 'src/web/pages/profile.tsx'])
		)
		// The guarded calls exist, so the rule is not vacuous.
		expect(SOURCES.filter((s) => ANONYMOUS(s.path) && s.text.includes('contextOf(null')).length).toBeGreaterThan(0)
	})

	it('keeps the page reads anonymous and the web layer off the Store', () => {
		expect(violations(SOURCES)).toEqual([])
	})

	guardFixtures(
		violations,
		{
			flagged: {
				'a credential type from auth': [
					"import { type Credential, contextOf } from '../auth'",
					'src/domain/web-pages/probe.ts:1 imports Credential from src/domain/auth',
				],
				authorize: [
					"import { authorize } from '../auth'",
					'src/domain/web-pages/probe.ts:1 imports authorize from src/domain/auth',
				],
				'a namespace of auth': [
					"import * as auth from '../auth'",
					'src/domain/web-pages/probe.ts:1 imports * from src/domain/auth',
				],
				'the web session': [
					"import { sessionOf } from '../web-session'",
					'src/domain/web-pages/probe.ts:1 imports src/domain/web-session',
				],
				'a viewer context for an account': [
					"import { contextOf } from '../auth'\nconst v = contextOf(accountId, now)",
					'src/domain/web-pages/probe.ts:2 makes a viewer context for someone',
				],
				'a run-time import of a guarded module': [
					"const m = await import('../auth')",
					'src/domain/web-pages/probe.ts:1 imports all of src/domain/auth',
				],
				'a renamed contextOf': [
					"import { contextOf as viewer } from '../auth'\nconst v = viewer(accountId, now)",
					'src/domain/web-pages/probe.ts:1 renames an import of src/domain/auth as viewer',
				],
				'an import type of a credential': [
					"type C = import('../auth').Credential",
					'src/domain/web-pages/probe.ts:1 imports Credential from src/domain/auth',
				],
			},
			passed: {
				'the anonymous context': "import { contextOf } from '../auth'\nconst v = contextOf(null, now)",
				'a domain module': "import { readOperation } from '../operation'",
			},
		},
		{ path: 'src/domain/web-pages/probe.ts' }
	)

	guardFixtures(
		violations,
		{
			flagged: {
				'the cookie helpers': [
					"import { getCookie } from 'hono/cookie'",
					'src/app/public-pages.tsx:1 imports hono/cookie',
				],
				'the session module': [
					"import { SESSION_COOKIE } from '../web/session'",
					'src/app/public-pages.tsx:1 imports src/web/session',
				],
				'a credential from the API context': [
					"import { credential, storeCall } from '../mastodon/context'",
					'src/app/public-pages.tsx:1 imports credential from src/mastodon/context',
				],
			},
			passed: {
				'the Store call and the request origin':
					"import { type ApiDeps, present, storeCall } from '../mastodon/context'",
			},
		},
		{ path: 'src/app/public-pages.tsx' }
	)

	guardFixtures(
		violations,
		{
			flagged: {
				'the database': ["import { Db } from '../../db/sql'", 'src/web/pages/probe.tsx:1 imports src/db/sql'],
				'the Store client': [
					"import { callStore } from '../../platform/store-client'",
					'src/web/pages/probe.tsx:1 imports src/platform/store-client',
				],
				'the Store': ["import type { Store } from '../../store'", 'src/web/pages/probe.tsx:1 imports src/store'],
				'the database at run time': [
					"const sql = await import('../../db/sql')",
					'src/web/pages/probe.tsx:1 imports src/db/sql',
				],
				'an import type of the Store': [
					"type S = import('../../store').Store",
					'src/web/pages/probe.tsx:1 imports src/store',
				],
			},
			passed: {
				'domain types': "import type { Status } from '../../domain/status-presenter'",
			},
		},
		{ path: 'src/web/pages/probe.tsx' }
	)
})
