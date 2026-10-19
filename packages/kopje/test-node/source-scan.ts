import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseSync, visitorKeys, type Node, type Program } from 'oxc-parser'
import { expect, it } from 'vitest'

// The base of the source guards: tests that read the package's own code and assert a rule about it. Each reads its
// files with sources(), parses them with parse() (comments never count as code), and proves with guardFixtures()
// that its finder still flags what it must and passes what it may, through the same path as the real files.
//
// Parser: oxc-parser, through parseSync only. It reads TS and JS into ESTree (its JS output matches acorn's). The
// package's TypeScript 7 has no in-process compiler API, acorn reads no TypeScript, and Babel 8's AST is not ESTree
// without a plugin and is heavier. Offsets are UTF-16 code units, as String#slice counts them; parentheses are not
// kept as nodes (preserveParens: false), as in acorn.

export type Source = { path: string; text: string }

const PACKAGE = fileURLToPath(new URL('../', import.meta.url))

// The files under `dir` (relative to the package, as 'src/domain') with one of `extensions`, declaration files left
// out, by their package-relative paths. A directory with none throws, so a guard cannot pass over nothing.
export function sources(dir: string, extensions: readonly string[] = ['.ts', '.tsx']): Source[] {
	const walk = (path: string): string[] =>
		readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
			const child = join(path, entry.name)
			if (entry.isDirectory()) {
				return walk(child)
			}
			return extensions.some((e) => entry.name.endsWith(e)) && !entry.name.endsWith('.d.ts') ? [child] : []
		})
	const files = walk(join(PACKAGE, dir))
		.map((path) => ({ path: relative(PACKAGE, path).replaceAll('\\', '/'), text: readFileSync(path, 'utf8') }))
		.sort((a, b) => (a.path < b.path ? -1 : 1))
	if (files.length === 0) {
		throw new Error(`no sources in ${dir}`)
	}
	return files
}

// A string or template literal: its text parts and interpolated expressions in order, its ancestors (nearest first),
// and the name of the constant it initializes (`const NAME = '...'`, with or without `as const` or a type; never a
// `let` or `var`, which may be reassigned).
export type Part = { text: string } | { expression: Node; source: string }
export type Literal = { node: Node; parts: Part[]; parents: Node[]; constant: string | null }

export type Parsed = {
	program: Program
	// The text with every comment blanked, line breaks kept, so offsets and lines stay those of the file.
	code: string
	literals: Literal[]
}

const parsed = new WeakMap<Source, Parsed>()

// The parse of a source, by its path's extension. A parse error throws: a guard does not skip what it cannot read.
export function parse(source: Source): Parsed {
	const cached = parsed.get(source)
	if (cached !== undefined) {
		return cached
	}
	const result = parseSync(source.path, source.text, { preserveParens: false })
	const error = result.errors[0]
	if (error !== undefined) {
		const at = error.labels[0]?.start
		throw new Error(`${source.path}${at === undefined ? '' : `:${lineOf(source.text, at)}`}: ${error.message}`)
	}
	let code = ''
	let from = 0
	for (const comment of result.comments) {
		code +=
			source.text.slice(from, comment.start) + source.text.slice(comment.start, comment.end).replace(/[^\n]/g, ' ')
		from = comment.end
	}
	code += source.text.slice(from)
	const literals: Literal[] = []
	walk(result.program, (node, parents) => {
		if (node.type === 'Literal' && typeof node.value === 'string') {
			literals.push({ node, parts: [{ text: node.value }], parents, constant: constantOf(node, parents) })
		} else if (node.type === 'TemplateLiteral') {
			const parts: Part[] = []
			node.quasis.forEach((quasi, i) => {
				parts.push({ text: quasi.value.cooked ?? quasi.value.raw })
				const expression = node.expressions[i]
				if (expression !== undefined) {
					parts.push({ expression, source: source.text.slice(expression.start, expression.end) })
				}
			})
			literals.push({ node, parts, parents, constant: constantOf(node, parents) })
		}
	})
	const value = { program: result.program, code, literals }
	parsed.set(source, value)
	return value
}

function constantOf(node: Node, parents: readonly Node[]): string | null {
	let child: Node = node
	for (const [i, parent] of parents.entries()) {
		if (parent.type === 'TSAsExpression' || parent.type === 'TSSatisfiesExpression') {
			child = parent
			continue
		}
		const declaration = parents[i + 1]
		return parent.type === 'VariableDeclarator' &&
			parent.init === child &&
			parent.id.type === 'Identifier' &&
			declaration?.type === 'VariableDeclaration' &&
			declaration.kind === 'const'
			? parent.id.name
			: null
	}
	return null
}

// Visits `node` and every node below it in source order, each with its ancestors, nearest first.
export function walk(node: Node, visit: (node: Node, parents: Node[]) => void, parents: Node[] = []): void {
	visit(node, parents)
	const inner = [node, ...parents]
	for (const key of visitorKeys[node.type] ?? []) {
		const value = (node as unknown as Record<string, unknown>)[key]
		for (const child of Array.isArray(value) ? value : [value]) {
			if (typeof child === 'object' && child !== null && typeof (child as Node).type === 'string') {
				walk(child as Node, visit, inner)
			}
		}
	}
}

export function lineOf(text: string, offset: number): number {
	return text.slice(0, offset).split('\n').length
}

// The self-check of a guard: `find` (the guard's own finder, given sources) reports each `flagged` fixture's finding
// and nothing for each `passed` fixture. A fixture is the text of one file at `path`; with `over`, it joins those
// sources in place of the one at its path.
export function guardFixtures(
	find: (sources: Source[]) => readonly string[],
	cases: { flagged: Record<string, [text: string, finding: string]>; passed: Record<string, string> },
	{ path = 'src/domain/probe.ts', over = [] }: { path?: string; over?: readonly Source[] } = {}
): void {
	const sources = (text: string) => [...over.filter((s) => s.path !== path), { path, text }]
	it.each(Object.entries(cases.flagged))('flags %s', (_name, [text, finding]) => {
		expect(find(sources(text))).toContain(finding)
	})
	it.each(Object.entries(cases.passed))('passes %s', (_name, text) => {
		expect(find(sources(text))).toEqual([])
	})
}
