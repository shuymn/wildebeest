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
// LEFT_FOR_RB2 counts, per module and raw presenter, the uses it still makes (each mention of the imported name):
// the answers RB2 budgets (notifications, conversations, reports, admin account lists, edge-cursor account pages and
// the directory). It is exact: a further use of an allowed import fails, and so does an entry no longer used, so it
// shrinks with each change. The guard is architectural; the aggregate response
// tests (test/answer-budgets.test.ts) prove the budgets.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

// Each raw presenter by its module (relative to the package, without extension).
const RAW: Readonly<Record<string, readonly string[]>> = {
	'src/domain/status-presenter': ['presentStatuses'],
	'src/domain/accounts': ['presentAccountsById', 'presentAccount'],
}

const LEFT_FOR_RB2: Readonly<Record<string, Readonly<Record<string, number>>>> = {
	'src/domain/admin-accounts.ts': { presentAccount: 1 },
	'src/domain/blocks.ts': { presentAccount: 2 },
	'src/domain/conversations.ts': { presentAccountsById: 1, presentStatuses: 1 },
	'src/domain/directory.ts': { presentAccount: 1 },
	'src/domain/notification-groups.ts': { presentAccountsById: 2, presentStatuses: 1 },
	'src/domain/notification-requests.ts': { presentAccountsById: 1, presentStatuses: 1 },
	'src/domain/notifications.ts': { presentAccountsById: 1, presentStatuses: 1 },
	'src/domain/reports.ts': { presentAccountsById: 2, presentStatuses: 1 },
	// present() hydrates the accounts of the ids it is given: a page for presentStatuses until RB2 removes it, then
	// one chunk of statuses.
	'src/domain/status-presenter.ts': { presentAccountsById: 1 },
}

type SourceNode = Node & Record<string, unknown>

type Finding = { file: string; name: string; how: 'import' | 'use' | 're-export' | 'namespace' | 'dynamic import' }

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
	// The local names of the raw presenters the file imports, with the presenter each names.
	const locals = new Map<string, string>()
	const own = file.replace(/\.(ts|tsx)$/, '')
	const raw = (module: string | null) => (module === null || module === own ? [] : (RAW[module] ?? []))
	// Imports first, wherever they stand: a binding is in scope in the whole module, so a use may precede its import.
	for (const node of (root as SourceNode).statements as SourceNode[]) {
		if (node.kind !== SyntaxKind.ImportDeclaration) {
			continue
		}
		const clause = node.importClause as SourceNode | undefined
		const module = moduleOf(file, text(node.moduleSpecifier))
		const names = raw(module)
		if (clause === undefined || clause.isTypeOnly === true || names.length === 0) {
			continue
		}
		const bindings = clause.namedBindings as SourceNode | undefined
		if (bindings?.kind === SyntaxKind.NamespaceImport) {
			namespaces.set(text(bindings.name), module ?? '')
		}
		for (const element of (bindings?.elements as SourceNode[] | undefined) ?? []) {
			const name = text(element.propertyName ?? element.name)
			if (element.isTypeOnly !== true && names.includes(name)) {
				found.push({ file, name, how: 'import' })
				locals.set(text(element.name), name)
			}
		}
	}
	const visit = (node: SourceNode): void => {
		switch (node.kind) {
			case SyntaxKind.ImportDeclaration:
				return
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
				// A local re-export of an imported presenter (`export { p }`) is a use, counted below.
				break
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
				const parent = node.parent as SourceNode | undefined
				// Every mention of an imported presenter's local name, but as another object's property name.
				const presenter = locals.get(text(node))
				const property =
					(parent?.kind === SyntaxKind.PropertyAccessExpression && parent.name === node) ||
					(parent?.kind === SyntaxKind.QualifiedName && parent.right === node) ||
					(parent?.kind === SyntaxKind.PropertyAssignment && parent.name === node)
				if (presenter !== undefined && !property) {
					found.push({ file, name: presenter, how: 'use' })
				}
				// A namespace of a presenter module: only a property access (or a qualified type name) by a name other than
				// a raw presenter's.
				const module = namespaces.get(text(node))
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
		[
			'a namespace access before its import',
			"export const f = a.presentAccount\nimport * as a from './domain/accounts'",
			'namespace',
		],
	])('finds %s', (_name, text, how) => {
		expect(scan({ 'src/x.ts': text }).map((finding) => finding.how)).toEqual([how])
	})

	it('counts every use of an imported presenter, before its import and under an alias too', () => {
		const text = `export const early = p(1)
import { presentAccount as p } from './domain/accounts'
export const late = [p(2), { p: 3 }.p]
export { p }`
		expect(scan({ 'src/x.ts': text }).map((finding) => `${finding.how} ${finding.name}`)).toEqual([
			'import presentAccount',
			'use presentAccount',
			'use presentAccount',
			'use presentAccount',
		])
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

	it('are used only by their modules and the counted sites left for RB2', () => {
		const imported: Record<string, string[]> = {}
		const used: Record<string, Record<string, number>> = {}
		const other: Finding[] = []
		for (const { file, root } of program) {
			for (const finding of findings(file, root)) {
				if (finding.how === 'import') {
					imported[file] = [...(imported[file] ?? []), finding.name].toSorted()
				} else if (finding.how === 'use') {
					const counts = (used[file] ??= {})
					counts[finding.name] = (counts[finding.name] ?? 0) + 1
				} else {
					other.push(finding)
				}
			}
		}
		expect(other).toEqual([])
		expect(used).toEqual(LEFT_FOR_RB2)
		expect(imported).toEqual(
			Object.fromEntries(Object.entries(LEFT_FOR_RB2).map(([file, uses]) => [file, Object.keys(uses).toSorted()]))
		)
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
