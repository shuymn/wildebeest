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

// The package-relative path a relative specifier of `from` names (`../db/sql` from `src/web/a.ts` is `src/db/sql`).
export function resolve(from: string, specifier: string): string {
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

// A string or template literal: its text parts and interpolated expressions in order, its ancestors (nearest first),
// and the name of the constant it initializes (`const NAME = '...'`, with or without `as const` or a type; never a
// `let` or `var`, which may be reassigned). An expression's source is its canonical() key, so a guard keyed by it reads the same
// under any formatter style.
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
					parts.push({ expression, source: canonical(expression) })
				}
			})
			literals.push({ node, parts, parents, constant: constantOf(node, parents) })
		}
	})
	const value = { program: result.program, code, literals }
	parsed.set(source, value)
	return value
}

// The key of an expression, printed from its syntax tree and never from its text, so formatting (quotes, whitespace,
// line breaks, semicolons, trailing commas, redundant parentheses) cannot change it and two different trees never
// share one. Identifiers, member access, calls, spreads, arrays (a hole printed as an empty slot), templates (their raw
// text), string literals (their value, see quoted()), numbers (their value), regular expressions (pattern and flags),
// unary, binary, logical and conditional expressions (a compound operand in parentheses) print as JavaScript that
// parses back to the same tree. Any other node prints as its type and every property but its position, in key order,
// inside `Type{…}`, which no printed JavaScript above produces outside a literal.
function canonical(node: Node): string {
	const n = node as Node & Record<string, unknown>
	const sub = (child: unknown) => canonical(child as Node)
	const operand = (child: unknown) => {
		const type = (child as Node).type
		return COMPOUND.has(type) ? `(${sub(child)})` : sub(child)
	}
	switch (n.type) {
		case 'Identifier':
		case 'PrivateIdentifier':
			return `${n.type === 'PrivateIdentifier' ? '#' : ''}${String(n.name)}`
		case 'ThisExpression':
			return 'this'
		case 'Literal':
			if (typeof n.value === 'string') {
				return quoted(n.value)
			}
			if (typeof n.bigint === 'string') {
				return `${n.bigint}n`
			}
			if (n.regex !== undefined && n.regex !== null) {
				const { pattern, flags } = n.regex as { pattern: string; flags: string }
				return `/${pattern}/${flags}`
			}
			return String(n.value)
		case 'TemplateLiteral': {
			const quasis = n.quasis as { value: { raw: string } }[]
			const expressions = n.expressions as Node[]
			return `\`${quasis.map((q, i) => q.value.raw + (i < expressions.length ? `\${${sub(expressions[i])}}` : '')).join('')}\``
		}
		case 'ChainExpression':
			return sub(n.expression)
		case 'MemberExpression': {
			const object = operand(n.object)
			const dot = n.optional === true ? '?.' : n.computed === true ? '' : '.'
			return n.computed === true ? `${object}${dot}[${sub(n.property)}]` : `${object}${dot}${sub(n.property)}`
		}
		case 'CallExpression':
			return `${operand(n.callee)}${n.optional === true ? '?.' : ''}(${(n.arguments as Node[]).map(sub).join(', ')})`
		case 'SpreadElement':
			return `...${operand(n.argument)}`
		case 'ArrayExpression': {
			const elements = n.elements as (Node | null)[]
			const printed = elements.map((e) => (e === null ? '' : sub(e))).join(', ')
			return `[${printed}${elements.at(-1) === null ? ',' : ''}]`
		}
		case 'UnaryExpression': {
			const word = /^[a-z]/.test(String(n.operator)) ? ' ' : ''
			const argument = n.argument as Node
			return `${String(n.operator)}${word}${argument.type === 'UnaryExpression' ? `(${sub(argument)})` : operand(argument)}`
		}
		case 'BinaryExpression':
		case 'LogicalExpression':
			return `${operand(n.left)} ${String(n.operator)} ${operand(n.right)}`
		case 'ConditionalExpression':
			return `${operand(n.test)} ? ${operand(n.consequent)} : ${operand(n.alternate)}`
		default:
			return generic(n)
	}
}

const COMPOUND = new Set(['UnaryExpression', 'BinaryExpression', 'LogicalExpression', 'ConditionalExpression'])
const POSITION = new Set(['type', 'start', 'end', 'range', 'loc'])

function generic(node: Record<string, unknown>): string {
	const value = (v: unknown): string => {
		if (v === null) {
			return '<null>'
		}
		if (Array.isArray(v)) {
			return `[${v.map(value).join(' ')}]`
		}
		if (typeof v === 'object' && typeof (v as Node).type === 'string') {
			return canonical(v as Node)
		}
		return JSON.stringify(v) ?? '<undefined>'
	}
	const fields = Object.keys(node)
		.filter((k) => !POSITION.has(k))
		.sort()
		.map((k) => `${k}=${value(node[k])}`)
	return `${String(node.type)}{${fields.join(' ')}}`
}

function quoted(value: string): string {
	const quote = [...value].filter((c) => c === "'").length > [...value].filter((c) => c === '"').length ? '"' : "'"
	const escaped = [...value]
		.map((c) => {
			if (c === quote || c === '\\') {
				return `\\${c}`
			}
			return c === ' ' || /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u.test(c) ? c : `\\u{${c.codePointAt(0)!.toString(16)}}`
		})
		.join('')
	return `${quote}${escaped}${quote}`
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

// Fixture edits that hold under any formatter style. statement(code) matches `code` as a statement on a line of its
// own, with any indentation (captured as $1) and an optional semicolon. editOnce replaces the one match of `pattern`
// (`$1` and the like as in String#replace) and throws unless it matches exactly once, so a fixture cannot silently
// stop editing the code it names.
export function statement(code: string): RegExp {
	return new RegExp(`^([ \\t]*)${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')};?$`, 'm')
}

export function editOnce(text: string, pattern: RegExp, replacement: string): string {
	const count = [...text.matchAll(new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g'))].length
	if (count !== 1) {
		throw new Error(`${pattern} matches ${count} times`)
	}
	return text.replace(pattern, replacement)
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
