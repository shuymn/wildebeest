import type { Node } from 'oxc-parser'
import { describe, expect, it } from 'vitest'

import { guardFixtures, lineOf, parse, sources, walk, type Source } from './source-scan.js'

// The public pages' boundary (design §1 "Enforcement", VIS-4): a page read and the public routes see no viewer. The
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

function resolve(from: string, specifier: string): string {
	if (!specifier.startsWith('.')) {
		return specifier
	}
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

function violations(files: readonly Source[]): string[] {
	const found: string[] = []
	for (const source of files) {
		const file = source.path
		const anonymous = ANONYMOUS(file)
		const web = file.startsWith('src/web/')
		if (!anonymous && !web) {
			continue
		}
		walk(parse(source).program, (node) => {
			const line = lineOf(source.text, node.start)
			if (
				node.type === 'ImportDeclaration' ||
				node.type === 'ExportNamedDeclaration' ||
				node.type === 'ExportAllDeclaration'
			) {
				if (node.source === null || node.source === undefined) {
					return
				}
				const target = resolve(file, String(node.source.value)).replace(/\.tsx?$/, '')
				if (web && WEB_FORBIDDEN.some((pattern) => pattern.test(target))) {
					found.push(`${file}:${line} imports ${target}`)
				}
				if (!anonymous) {
					return
				}
				if (FORBIDDEN.has(target)) {
					found.push(`${file}:${line} imports ${target}`)
				}
				const allowed = ALLOWED_NAMES[target]
				if (allowed !== undefined) {
					const specifiers = 'specifiers' in node ? node.specifiers : []
					if (node.type === 'ExportAllDeclaration' || specifiers.length === 0) {
						found.push(`${file}:${line} imports all of ${target}`)
					}
					for (const specifier of specifiers) {
						const name = specifierName(specifier)
						if (!allowed.includes(name)) {
							found.push(`${file}:${line} imports ${name} from ${target}`)
						}
					}
				}
				return
			}
			if (anonymous && node.type === 'ImportExpression') {
				found.push(`${file}:${line} imports a module at run time`)
			}
			if (
				anonymous &&
				node.type === 'CallExpression' &&
				node.callee.type === 'Identifier' &&
				node.callee.name === 'contextOf'
			) {
				const viewer = node.arguments[0]
				if (viewer?.type !== 'Literal' || viewer.value !== null) {
					found.push(`${file}:${line} makes a viewer context for someone`)
				}
			}
		})
	}
	return found
}

const SOURCES = sources('src')

describe('the public pages’ boundary (design §1, VIS-4)', () => {
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
				'a run-time import': [
					"const m = await import('../auth')",
					'src/domain/web-pages/probe.ts:1 imports a module at run time',
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
			},
			passed: {
				'domain types': "import type { Status } from '../../domain/status-presenter'",
			},
		},
		{ path: 'src/web/pages/probe.tsx' }
	)
})
