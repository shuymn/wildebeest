import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type Node, SyntaxKind } from 'typescript/unstable/ast'
import { createVirtualFileSystem } from 'typescript/unstable/fs'
import { API } from 'typescript/unstable/sync'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// RES-3 (docs/response-inventory.md): an answer of many statuses or accounts is presented within its answer budget by
// the Store operation that owns it, through the budgeted presenters (presentStatusesWithin, presentAccountsWithin,
// admit). The raw presenters build an answer of any size, so they stay in their modules: this test reads the program
// that tsconfig.json declares, through TypeScript's own parser, and fails on any import, re-export or namespace
// access of a raw presenter in src/ outside its module, and on a dynamic import of its module.
//
// LEFT_FOR_RB2 names, per module, the raw presenters it still imports: the answers RB2 budgets (notifications,
// conversations, reports, admin account lists, edge-cursor account pages and the directory). It is exact: an entry
// no longer imported fails too, so it shrinks with each change. The guard is architectural; the aggregate response
// tests (test/answer-budgets.test.ts) prove the budgets.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

// Each raw presenter by its module (relative to the package, without extension).
const RAW: Readonly<Record<string, readonly string[]>> = {
	'src/domain/status-presenter': ['presentStatuses'],
	'src/domain/accounts': ['presentAccountsById', 'presentAccount'],
}

const LEFT_FOR_RB2: Readonly<Record<string, readonly string[]>> = {
	'src/domain/admin-accounts.ts': ['presentAccount'],
	'src/domain/blocks.ts': ['presentAccount'],
	'src/domain/conversations.ts': ['presentAccountsById', 'presentStatuses'],
	'src/domain/directory.ts': ['presentAccount'],
	'src/domain/notification-groups.ts': ['presentAccountsById', 'presentStatuses'],
	'src/domain/notification-requests.ts': ['presentAccountsById', 'presentStatuses'],
	'src/domain/notifications.ts': ['presentAccountsById', 'presentStatuses'],
	'src/domain/reports.ts': ['presentAccountsById', 'presentStatuses'],
	// present() hydrates the accounts of the ids it is given: a page for presentStatuses until RB2 removes it, then
	// one atomic item, read through a single-item helper.
	'src/domain/status-presenter.ts': ['presentAccountsById'],
}

type SourceNode = Node & Record<string, unknown>

type Finding = { file: string; name: string; how: 'import' | 're-export' | 'namespace' | 'dynamic import' }

// The module a relative specifier names, relative to the package and without extension; null for a package.
function moduleOf(file: string, specifier: string): string | null {
	if (!specifier.startsWith('.')) {
		return null
	}
	return join(dirname(file), specifier).replace(/\.(ts|tsx|js)$/, '')
}

function text(node: unknown): string {
	return (node as { text?: string } | undefined)?.text ?? ''
}

// The raw presenters a source file reaches outside their module.
function findings(file: string, root: Node): Finding[] {
	const found: Finding[] = []
	const namespaces = new Map<string, string>()
	const own = file.replace(/\.(ts|tsx)$/, '')
	const raw = (module: string | null) => (module === null || module === own ? [] : (RAW[module] ?? []))
	const visit = (node: SourceNode): void => {
		switch (node.kind) {
			case SyntaxKind.ImportDeclaration: {
				const clause = node.importClause as SourceNode | undefined
				const names = raw(moduleOf(file, text(node.moduleSpecifier)))
				if (clause !== undefined && clause.isTypeOnly !== true && names.length > 0) {
					const bindings = clause.namedBindings as SourceNode | undefined
					if (bindings?.kind === SyntaxKind.NamespaceImport) {
						namespaces.set(text(bindings.name), moduleOf(file, text(node.moduleSpecifier)) ?? '')
					}
					for (const element of (bindings?.elements as SourceNode[] | undefined) ?? []) {
						const name = text(element.propertyName ?? element.name)
						if (element.isTypeOnly !== true && names.includes(name)) {
							found.push({ file, name, how: 'import' })
						}
					}
				}
				return
			}
			case SyntaxKind.ExportDeclaration: {
				const names = raw(moduleOf(file, text(node.moduleSpecifier)))
				const clause = node.exportClause as SourceNode | undefined
				if (names.length > 0 && node.isTypeOnly !== true) {
					if (clause === undefined || clause.kind === SyntaxKind.NamespaceExport) {
						found.push({ file, name: '*', how: 're-export' })
					}
					for (const element of (clause?.elements as SourceNode[] | undefined) ?? []) {
						const name = text(element.propertyName ?? element.name)
						if (names.includes(name)) {
							found.push({ file, name, how: 're-export' })
						}
					}
				}
				return
			}
			case SyntaxKind.CallExpression: {
				const callee = node.expression as SourceNode
				if (callee.kind === SyntaxKind.ImportKeyword) {
					const [specifier] = node.arguments as SourceNode[]
					const module = specifier?.kind === SyntaxKind.StringLiteral ? moduleOf(file, text(specifier)) : null
					if (specifier?.kind !== SyntaxKind.StringLiteral || raw(module).length > 0) {
						found.push({ file, name: text(specifier) || '<expression>', how: 'dynamic import' })
					}
				}
				break
			}
			case SyntaxKind.Identifier: {
				// A namespace of a presenter module: only a property access (or a qualified type name) by a name other than
				// a raw presenter's.
				const module = namespaces.get(text(node))
				const parent = node.parent as SourceNode | undefined
				if (module !== undefined && parent?.kind !== SyntaxKind.NamespaceImport) {
					const access = parent?.kind === SyntaxKind.PropertyAccessExpression && parent.expression === node
					const qualified = parent?.kind === SyntaxKind.QualifiedName && parent.left === node
					const name = access ? text(parent.name) : qualified ? text(parent.right) : ''
					if (name === '' || (RAW[module] ?? []).includes(name)) {
						found.push({ file, name: name || text(node), how: 'namespace' })
					}
				}
				break
			}
		}
		node.forEachChild((child) => visit(child as SourceNode))
	}
	visit(root as SourceNode)
	return found
}

type Program = { file: string; root: Node }[]

// The source files under src/ of the project `config` declares, read by TypeScript's parser, relative to `root`.
function sourcesOf(api: API, root: string, config: string): Program {
	const project = api.updateSnapshot({ openProject: join(root, config) }).getProjects()[0]
	if (project === undefined) {
		throw new Error(`${config} declares no project`)
	}
	return project.program
		.getSourceFileNames()
		.map((name) => ({ name, file: relative(root, name) }))
		.filter(({ file }) => file.startsWith('src/'))
		.map(({ name, file }) => {
			const source = project.program.getSourceFile(name)
			if (source === undefined) {
				throw new Error(`no source file for ${file}`)
			}
			return { file, root: source }
		})
}

// The findings of a program of the given sources (the presenter modules are added), as a virtual project.
function scan(sources: Record<string, string>): Finding[] {
	const root = '/virtual'
	const files: Record<string, string> = {
		[`${root}/tsconfig.json`]: JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['src'] }),
		[`${root}/src/domain/accounts.ts`]:
			'export function presentAccount() {}\nexport function presentAccountsById() {}\nexport function ok() {}',
		[`${root}/src/domain/status-presenter.ts`]: 'export function presentStatuses() {}\nexport type Status = {}',
		...Object.fromEntries(Object.entries(sources).map(([file, text]) => [`${root}/${file}`, text])),
	}
	const api = new API({ cwd: root, fs: createVirtualFileSystem(files) })
	try {
		return sourcesOf(api, root, 'tsconfig.json')
			.filter(({ file }) => file in sources)
			.flatMap(({ file, root: node }) => findings(file, node))
	} finally {
		api.close()
	}
}

let api: API | undefined
let program: Program = []

beforeAll(() => {
	api = new API({ cwd: ROOT })
	program = sourcesOf(api, ROOT, 'tsconfig.json')
})

afterAll(() => {
	api?.close()
})

describe('the raw presenter finder', () => {
	it.each([
		['an import', "import { presentStatuses } from './domain/status-presenter'", 'import'],
		['an aliased import', "import { presentAccount as p } from './domain/accounts'", 'import'],
		['a re-export', "export { presentAccountsById } from './domain/accounts'", 're-export'],
		['an aliased re-export', "export { presentStatuses as s } from './domain/status-presenter'", 're-export'],
		['a star re-export', "export * from './domain/accounts'", 're-export'],
		['a namespace re-export', "export * as a from './domain/accounts'", 're-export'],
		['a namespace access', "import * as a from './domain/accounts'\nexport const f = a.presentAccount", 'namespace'],
		['a namespace passed on', "import * as a from './domain/accounts'\nexport const f = [a]", 'namespace'],
		['an element access', "import * as a from './domain/accounts'\nexport const f = a['presentAccount']", 'namespace'],
		['a dynamic import', "export const f = import('./domain/status-presenter')", 'dynamic import'],
		['a computed dynamic import', "const m = './x'\nexport const f = import(m)", 'dynamic import'],
	])('finds %s', (_name, text, how) => {
		expect(scan({ 'src/x.ts': text }).map((finding) => finding.how)).toEqual([how])
	})

	it.each([
		['a type import', "import type { Status } from './domain/status-presenter'"],
		['a type-only specifier', "import { type Status } from './domain/status-presenter'"],
		['another export', "import { ok } from './domain/accounts'\nexport const f = ok"],
		['a namespace access of another export', "import * as a from './domain/accounts'\nexport const f = a.ok"],
		['a module of the same name elsewhere', "import { presentAccount } from './accounts'", 'src/other/x.ts'],
	])('passes %s', (_name, text, file = 'src/x.ts') => {
		expect(scan({ [file]: text })).toEqual([])
	})
})

describe('raw presenters (RES-3)', () => {
	it('reads every source file of the program', () => {
		const onDisk = (dir: string): string[] =>
			readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
				entry.isDirectory() ? onDisk(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []
			)
		expect(program.map(({ file }) => file).toSorted()).toEqual(onDisk('src').toSorted())
	})

	it('are imported only by their modules and the sites left for RB2', () => {
		const imported: Record<string, string[]> = {}
		const other: Finding[] = []
		for (const { file, root } of program) {
			for (const finding of findings(file, root)) {
				if (finding.how === 'import') {
					imported[file] = [...(imported[file] ?? []), finding.name].toSorted()
				} else {
					other.push(finding)
				}
			}
		}
		expect(other).toEqual([])
		expect(imported).toEqual(LEFT_FOR_RB2)
	})

	it('are allowed only where the response inventory names an exemption', () => {
		const inventory = readFileSync(join(ROOT, 'docs/response-inventory.md'), 'utf8')
		// The last cell of each table row: the module exempt until its answer is budgeted.
		const exempt = [...inventory.matchAll(/\| `(src\/[^`]+)` +\|$/gm)].map((m) => m[1] ?? '')
		expect(inventory).toContain('(`src/domain/status-presenter.ts`) imports `presentAccountsById`')
		expect(exempt.toSorted()).toEqual(
			Object.keys(LEFT_FOR_RB2)
				.filter((file) => file !== 'src/domain/status-presenter.ts')
				.toSorted()
		)
	})
})
