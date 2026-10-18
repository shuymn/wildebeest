import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// docs/threat-model.md and the code agree ("Status of an invariant" there):
// - every italic mark is a status (_Enforced (main)_, _Planned (topic)_, _Retired_) or a _Gap_ note, every invariant
//   has a status, and no text names a branch (`kopje/<name>`, "on branch");
// - a part marked _Enforced (main)_ (its text up to the next status mark of the invariant) cites only paths that exist,
//   and each test file it cites with quoted names, `test/a.test.ts` ("name", "other … name"), contains every name
//   (each fragment around an ellipsis); a name follows its file in parentheses, never after a comma;
// - each status in the entry-point table is `main: <paths>` or `Planned (topic)`, and the paths exist.
// Cited test files do not have to name the invariant's id: most predate the convention, and the quoted names already
// tie a part to its tests.

const PACKAGE = new URL('../', import.meta.url)
const ROOT = new URL('../../../', import.meta.url)

/** What the checks read; a fake in the self-test below. */
interface Files {
	/** The file's text, or undefined when there is no such file. */
	read(path: string): string | undefined
	/** Whether a file or directory exists; a `*` in the last segment matches any characters but `/`. */
	exists(path: string): boolean
}

// Paths are relative to packages/kopje, except those starting with packages/ or /, which are relative to the
// repository root. A code span is a path when its first segment is one of these (so `/admin/*` is a route).
const PATH =
	/^(?:src|test|test-node|cli|scripts|docs|migrations|public|types|stubs|packages|\/deploy|\/scripts)\/[^\s<>]*$/
const MIGRATION = /^\d{4}_[a-z0-9_]+$/
const TEST_FILE = /\.test\.tsx?$/

function located(path: string): URL {
	if (path.startsWith('/')) return new URL(path.slice(1), ROOT)
	return new URL(path, path.startsWith('packages/') ? ROOT : PACKAGE)
}

const disk: Files = {
	read(path) {
		const url = located(path)
		return existsSync(url) && statSync(url).isFile() ? readFileSync(url, 'utf8') : undefined
	},
	exists(path) {
		const slash = path.lastIndexOf('/')
		const last = path.slice(slash + 1)
		if (!last.includes('*')) return existsSync(located(path))
		const directory = located(path.slice(0, slash + 1))
		if (!existsSync(directory)) return false
		const pattern = new RegExp(`^${last.split('*').map(escapeRegExp).join('[^/]*')}$`)
		return readdirSync(directory).some((name) => pattern.test(name))
	},
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

type Entry = { id: string; text: string }

/** Each invariant (`- **ID-1: ...**`) with its continuation lines, as one line: until the next invariant or heading,
 * or a blank line followed by an unindented one. */
function invariants(document: string): Entry[] {
	const found: Entry[] = []
	let current: { id: string; lines: string[] } | undefined
	const lines = document.split('\n')
	const close = () => {
		if (current !== undefined) found.push({ id: current.id, text: flatten(current.lines.join('\n')) })
		current = undefined
	}
	lines.forEach((line, i) => {
		const start = /^- \*\*([A-Z]+-\d+[a-z]?):/.exec(line)
		if (start?.[1] !== undefined) {
			close()
			current = { id: start[1], lines: [line] }
		} else if (/^#/.test(line) || (line.trim() === '' && /^\S/.test(lines[i + 1] ?? ''))) {
			close()
		} else {
			current?.lines.push(line)
		}
	})
	close()
	return found
}

function flatten(text: string): string {
	return text.replace(/\s+/g, ' ').trim()
}

/** The text with every code span's content replaced by `x`, so offsets stay and no `_` inside code counts. */
function masked(text: string): string {
	return text.replace(/`[^`]*`/g, (span) => `\`${'x'.repeat(span.length - 2)}\``)
}

type Mark = { kind: 'enforced' | 'planned' | 'retired' | 'gap' | 'unknown'; text: string; start: number; end: number }

const KINDS: readonly [Mark['kind'], RegExp][] = [
	['enforced', /^Enforced \(main\)[:.]?$/],
	['planned', /^Planned \([^()]+\)[:.]?$/],
	['retired', /^Retired(?: \([^()]+\))?[:.]?$/],
	['gap', /^Gap\b/],
]

/** Every italic span outside code, classified. */
function marks(text: string): Mark[] {
	const found: Mark[] = []
	for (const match of masked(text).matchAll(/(?<![\w\\])_(?=\S)([^_]*?\S)_(?!\w)/g)) {
		const inner = text.slice(match.index + 1, match.index + match[0].length - 1)
		const kind = KINDS.find(([, pattern]) => pattern.test(inner))?.[0] ?? 'unknown'
		found.push({ kind, text: inner, start: match.index, end: match.index + match[0].length })
	}
	return found
}

/** The parts marked _Enforced (main)_: from each such mark to the next status mark, or the end of the invariant. */
function enforcedParts(text: string): string[] {
	const statuses = marks(text).filter((mark) => mark.kind !== 'gap' && mark.kind !== 'unknown')
	return statuses.flatMap((mark, i) =>
		mark.kind === 'enforced' ? [text.slice(mark.end, statuses[i + 1]?.start ?? text.length)] : []
	)
}

type Citation = { path: string; names: string[]; afterComma: boolean }

/** The paths and migrations a text cites, each test file with the quoted names in the parentheses right after it. */
function citations(text: string): Citation[] {
	const found: Citation[] = []
	for (const match of text.matchAll(/`([^`]+)`/g)) {
		const span = match[1] ?? ''
		const after = text.slice(match.index + match[0].length)
		if (MIGRATION.test(span)) found.push({ path: `migrations/${span}.sql`, names: [], afterComma: false })
		if (!PATH.test(span)) continue
		const group = after.startsWith(' (') ? parenthesized(after.slice(1)) : ''
		const names = TEST_FILE.test(span) ? [...group.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => unescape(m[1])) : []
		found.push({ path: span, names, afterComma: TEST_FILE.test(span) && /^, "/.test(after) })
	}
	return found
}

function unescape(text: string | undefined): string {
	return (text ?? '').replace(/\\(.)/g, '$1')
}

/** The balanced parenthesized group a text starts with, quotes and code spans skipped. */
function parenthesized(text: string): string {
	let depth = 0
	let quoted: string | undefined
	for (let i = 0; i < text.length; i++) {
		const c = text[i]
		if (quoted !== undefined) {
			if (c === '\\') i++
			else if (c === quoted) quoted = undefined
		} else if (c === '"' || c === '`') {
			quoted = c
		} else if (c === '(') {
			depth++
		} else if (c === ')' && --depth === 0) {
			return text.slice(0, i + 1)
		}
	}
	return text
}

/** Whether a test file's source contains a quoted name: every fragment around an ellipsis, escapes read. */
function hasName(source: string, name: string): boolean {
	const plain = source.replace(/\\(['"`\\])/g, '$1')
	return name
		.split(/…|\.\.\./)
		.map((fragment) => fragment.trim())
		.filter((fragment) => fragment !== '')
		.every((fragment) => plain.includes(fragment))
}

/** The status cells of the entry-point table. */
function entryPointStatuses(document: string): string[] {
	const section = document.split('\n## Entry points\n')[1]?.split('\n## ')[0] ?? ''
	return section
		.split('\n')
		.filter((line) => line.startsWith('| ') && !line.startsWith('| Entry point') && !line.startsWith('| ---'))
		.map((line) => (line.split(' | ').at(-1) ?? '').replace(/\s*\|\s*$/, '').trim())
}

function citationProblems(where: string, part: string, files: Files): string[] {
	const problems: string[] = []
	for (const { path, names, afterComma } of citations(part)) {
		if (!files.exists(path)) {
			problems.push(`${where}: ${path} does not exist`)
			continue
		}
		if (afterComma) problems.push(`${where}: ${path} has a name after a comma, not in parentheses`)
		const source = names.length > 0 ? files.read(path) : undefined
		for (const name of names) {
			if (source === undefined || !hasName(source, name)) problems.push(`${where}: ${path} has no test "${name}"`)
		}
	}
	return problems
}

/** Every disagreement between the document and the files. */
function problems(document: string, files: Files): string[] {
	const found: string[] = []
	for (const mark of marks(flatten(document))) {
		if (mark.kind === 'unknown') found.push(`unknown mark _${mark.text}_`)
	}
	for (const match of flatten(document).matchAll(/\bon branch(?:es)?\b|`kopje\/[\w.-]+`/gi)) {
		found.push(`a branch status: "${match[0]}"`)
	}
	for (const { id, text } of invariants(document)) {
		if (!marks(text).some((mark) => mark.kind !== 'gap' && mark.kind !== 'unknown')) found.push(`${id}: no status`)
		for (const part of enforcedParts(text)) found.push(...citationProblems(id, part, files))
	}
	for (const status of entryPointStatuses(document)) {
		for (const part of status.split('; ')) {
			if (part.startsWith('main')) found.push(...citationProblems('entry points', part, files))
			else if (!/^Planned \([^()]+\)/.test(part)) found.push(`entry points: unknown status "${part}"`)
		}
	}
	return found
}

describe("the threat model's statuses", () => {
	const document = readFileSync(new URL('docs/threat-model.md', PACKAGE), 'utf8')

	it('reads the invariants, their enforced parts and their citations', () => {
		// Guards against a parser that silently finds nothing to compare.
		const entries = invariants(document)
		expect(entries.length).toBeGreaterThan(80)
		const parts = entries.flatMap(({ text }) => enforcedParts(text))
		expect(parts.length).toBeGreaterThan(150)
		const cited = parts.flatMap((part) => citations(part))
		expect(cited.filter(({ path }) => TEST_FILE.test(path)).length).toBeGreaterThan(300)
		expect(cited.flatMap(({ names }) => names).length).toBeGreaterThan(300)
		expect(entryPointStatuses(document).length).toBeGreaterThan(15)
	})

	it('marks every part with a known status, and cites what exists', () => {
		expect(problems(document, disk)).toEqual([])
	})

	it('detects every kind of disagreement', () => {
		const fixture = [
			'# Example',
			'',
			'## Entry points',
			'',
			'| Entry point | Reached by | Status and code |',
			'| --- | --- | --- |',
			'| Inbox | R1 | main: `src/a.ts` |',
			'| Web | R2 | main: `src/gone.ts`; Planned (web) |',
			'| Setup | R2 | branch `kopje/setup`: `src/a.ts` |',
			'',
			'## Invariants',
			'',
			'- **EX-1: kept.** _Enforced (main):_ `src/a.ts`, `src/dir/*.ts`; `test/a.test.ts` ("EX-1: holds", "two … parts",',
			'  "a \\"quoted\\" one", "a (parenthesized) one"), migration `0001_init`.',
			'- **EX-2: missing.** _Enforced (main):_ `src/gone.ts`; `test/a.test.ts` ("no such test"), migration `0002_gone`.',
			'- **EX-3: planned.** _Planned (later):_ `src/gone.ts`. _Gap:_ untested.',
			'- **EX-4: from a branch.** _Implemented on branch `kopje/x`:_ `src/a.ts`.',
			'- **EX-5: a comma.** _Enforced',
			'  (main):_ `test/a.test.ts`, "EX-1: holds". _Retired (merged into EX-1)._ `src/gone.ts`.',
			'- **EX-6: no status.** `src/a.ts`.',
			'- **EX-7: two parts.** _Enforced (main)_ for one: `src/a.ts`. _Planned (B9)_ for the other: `src/gone.ts`.',
			'  _Enforced (main)_ for a third: `test/a.test.ts` ("missing as well").',
			'',
			'## Accepted risks',
			'',
			'Text _italic text_ here.',
		].join('\n')
		const files: Record<string, string> = {
			'src/a.ts': '',
			'src/dir/b.ts': '',
			'migrations/0001_init.sql': '',
			'test/a.test.ts': `it('EX-1: holds') it('two halves, and parts') it("a \\"quoted\\" one") it('a (parenthesized) one')`,
		}
		const fake: Files = {
			read: (path) => files[path],
			exists: (path) => {
				const pattern = new RegExp(`^${path.split('*').map(escapeRegExp).join('[^/]*')}$`)
				return Object.keys(files).some((name) => pattern.test(name))
			},
		}
		expect(problems(fixture, fake)).toEqual([
			'unknown mark _Implemented on branch `kopje/x`:_',
			'unknown mark _italic text_',
			'a branch status: "`kopje/setup`"',
			'a branch status: "on branch"',
			'a branch status: "`kopje/x`"',
			'EX-2: src/gone.ts does not exist',
			'EX-2: test/a.test.ts has no test "no such test"',
			'EX-2: migrations/0002_gone.sql does not exist',
			'EX-4: no status',
			'EX-5: test/a.test.ts has a name after a comma, not in parentheses',
			'EX-6: no status',
			'EX-7: test/a.test.ts has no test "missing as well"',
			'entry points: src/gone.ts does not exist',
			'entry points: unknown status "branch `kopje/setup`: `src/a.ts`"',
		])
	})
})
