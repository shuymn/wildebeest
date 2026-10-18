import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// docs/threat-model.md and the code agree, by the contract its "Status of an invariant" states:
// - every `_..._` emphasis outside code is a status (_Enforced (main)_, _Planned (topic)_, _Retired_) or a _Gap_ note,
//   every invariant has a status, and no text names a branch (`kopje/<name>`, "on branch");
// - a part marked _Enforced (main)_ (its text up to the next status mark of the invariant) cites at least one file,
//   and every file it cites exists; a test file cited with quoted names, `test/a.test.ts` ("name", "other … name"),
//   declares a test or suite whose title contains each name (with `…`, its fragments in order within one title); a
//   name follows its file in parentheses only;
// - each status in the entry-point table is `main: <paths>` with at least one path, or exactly `Planned (topic)`.
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
// repository root. A code span is a path when its first segment is one of these (so `/admin/*` is a route), or a
// configuration file of the package named bare (`wrangler.jsonc`, `package.json`, `vitest.config.ts`).
const PATH =
	/^(?:src|test|test-node|cli|scripts|docs|migrations|public|types|stubs|packages|\/deploy|\/scripts)\/[^\s<>]*$/
const CONFIG =
	/^(?:package\.json|tsconfig(?:\.[\w-]+)?\.json|(?:[\w-]+\.)?wrangler\.jsonc?|[\w-]+(?:\.[\w-]+)*\.config\.[cm]?[jt]s)$/
const MIGRATION = /^\d{4}_[a-z0-9_]+$/
const TEST_FILE = /\.test\.tsx?$/
// A branch named anywhere: `kopje/<name>`, with any further segments, unless it is a path inside packages/kopje.
const BRANCH = /\bon branch(?:es)?\b|(?<![\w./-])kopje\/[\w-]+(?:[./][\w-]+)*/gi

function located(path: string): URL {
	if (path.startsWith('/')) return new URL(path.slice(1), ROOT)
	return new URL(path, path.startsWith('packages/') ? ROOT : PACKAGE)
}

/** A path whose last segment may hold `*`, as a pattern over that segment. */
function wildcard(segment: string): RegExp {
	return new RegExp(`^${segment.split('*').map(escapeRegExp).join('[^/]*')}$`)
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
		return existsSync(directory) && readdirSync(directory).some((name) => wildcard(last).test(name))
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

const isStatus = (mark: Mark) => mark.kind !== 'gap' && mark.kind !== 'unknown'

/** The parts marked _Enforced (main)_: from each such mark to the next status mark, or the end of the invariant. */
function enforcedParts(text: string, found: readonly Mark[]): string[] {
	const statuses = found.filter(isStatus)
	return statuses.flatMap((mark, i) =>
		mark.kind === 'enforced' ? [text.slice(mark.end, statuses[i + 1]?.start ?? text.length)] : []
	)
}

type Citation = { path: string; names: string[]; loose: boolean }

/** The files a text cites, each test file with the quoted names in the parentheses right after it. `loose` is a quoted
 * name that follows a test file in any other way (`, "name"`, `: "name"`), which the parser would not check. */
function citations(text: string): Citation[] {
	const found: Citation[] = []
	for (const match of text.matchAll(/`([^`]+)`/g)) {
		const span = match[1] ?? ''
		const after = text.slice(match.index + match[0].length)
		if (MIGRATION.test(span)) found.push({ path: `migrations/${span}.sql`, names: [], loose: false })
		if (!PATH.test(span) && !CONFIG.test(span)) continue
		const test = TEST_FILE.test(span)
		const group = test && after.startsWith(' (') ? parenthesized(after.slice(1)) : ''
		const names = [...group.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => (m[1] ?? '').replace(/\\(.)/g, '$1'))
		found.push({ path: span, names, loose: test && /^[,:;]? ?"/.test(after) })
	}
	return found
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

// A title's interpolation (`${...}` in a template literal), whose text is unknown: no fragment matches across it.
const HOLE = '\u0000'
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' }

/**
 * The titles a test file declares: the first argument of `it`, `test` and `describe`, with any chain (`.each(...)`,
 * `.skip`, `.skipIf(...)`) before it, when that argument is a string or template literal. Comments, strings and regular
 * expressions are skipped as tokens, so a name in a comment or in a test's body is no title.
 */
function titles(source: string): string[] {
	const found: string[] = []
	let i = 0
	let previous = ''
	while (i < source.length) {
		const c = source[i] ?? ''
		if (/\s/.test(c)) {
			i++
		} else if (source.startsWith('//', i)) {
			i = source.indexOf('\n', i) === -1 ? source.length : source.indexOf('\n', i)
		} else if (source.startsWith('/*', i)) {
			i = source.indexOf('*/', i + 2) === -1 ? source.length : source.indexOf('*/', i + 2) + 2
		} else if (c === "'" || c === '"' || c === '`') {
			i = literal(source, i).end
			previous = c
		} else if (c === '/' && (previous === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(previous))) {
			i = regex(source, i)
			previous = '/'
		} else if (/[A-Za-z_$]/.test(c)) {
			const word = /^[\w$]+/.exec(source.slice(i))?.[0] ?? c
			const start = i
			i += word.length
			if (['it', 'test', 'describe'].includes(word) && previous !== '.') {
				const title = callTitle(source, i)
				if (title !== undefined) found.push(title)
			}
			previous = source[start + word.length - 1] ?? ''
			if (word === 'return' || word === 'typeof') previous = '('
		} else {
			i++
			previous = c
		}
	}
	return found
}

/** The title of a call whose callee ends at `i`: the first literal argument after any chain of members and calls. */
function callTitle(source: string, i: number): string | undefined {
	let j = i
	for (;;) {
		while (/\s/.test(source[j] ?? '')) j++
		if (source[j] === '.') {
			j++
			j += /^[\w$]*/.exec(source.slice(j))?.[0].length ?? 0
		} else if (source[j] === '<') {
			j = typeArguments(source, j)
		} else if (source[j] === '(') {
			let k = j + 1
			while (/\s/.test(source[k] ?? '')) k++
			const quote = source[k]
			if (quote === "'" || quote === '"' || quote === '`') return literal(source, k).value
			j = balanced(source, j)
		} else {
			return undefined
		}
	}
}

/** The index after the type arguments at `i` (`<[string, (h: H) => T]>`), an arrow's `>` not closing them. */
function typeArguments(source: string, i: number): number {
	let depth = 0
	for (let j = i; j < source.length; j++) {
		const c = source[j]
		if (c === '<') depth++
		else if (c === '>' && source[j - 1] !== '=' && --depth === 0) return j + 1
	}
	return source.length
}

/** The end of the bracketed group that starts at `i`, skipping literals and comments. */
function balanced(source: string, i: number): number {
	let depth = 0
	let j = i
	while (j < source.length) {
		const c = source[j] ?? ''
		if (c === "'" || c === '"' || c === '`') {
			j = literal(source, j).end
			continue
		}
		if (source.startsWith('//', j)) j = source.indexOf('\n', j) === -1 ? source.length : source.indexOf('\n', j)
		else if (c === '(' || c === '[' || c === '{') depth++
		else if ((c === ')' || c === ']' || c === '}') && --depth === 0) return j + 1
		j++
	}
	return j
}

/** A string or template literal at `i`: its value (interpolations as HOLE) and the index after it. */
function literal(source: string, i: number): { value: string; end: number } {
	const quote = source[i]
	let value = ''
	let j = i + 1
	while (j < source.length && source[j] !== quote) {
		const c = source[j] ?? ''
		if (c === '\\') {
			const next = source[j + 1] ?? ''
			value += ESCAPES[next] ?? next
			j += 2
		} else if (quote === '`' && source.startsWith('${', j)) {
			value += HOLE
			j = balanced(source, j + 1)
		} else {
			value += c
			j++
		}
	}
	return { value, end: j + 1 }
}

/** The index after a regular expression literal at `i`. */
function regex(source: string, i: number): number {
	let j = i + 1
	let inClass = false
	while (j < source.length && source[j] !== '\n') {
		const c = source[j]
		if (c === '\\') j++
		else if (c === '[') inClass = true
		else if (c === ']') inClass = false
		else if (c === '/' && !inClass) return j + 1
		j++
	}
	return j
}

/** The fragments of a quoted name: the parts around `…`, or none when it names nothing. */
function fragments(name: string): string[] {
	return name
		.split('…')
		.map((fragment) => fragment.trim())
		.filter((fragment) => fragment !== '')
}

/** Whether one title holds every fragment, in order, none across an interpolation. */
function titled(declared: readonly string[], parts: readonly string[]): boolean {
	return declared.some((title) => {
		let at = 0
		for (const part of parts) {
			const found = title.indexOf(part, at)
			if (found === -1) return false
			at = found + part.length
		}
		return true
	})
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
	const cited = citations(part)
	if (cited.length === 0) problems.push(`${where}: an enforced part cites no file: "${part.trim().slice(0, 60)}"`)
	for (const { path, names, loose } of cited) {
		if (!files.exists(path)) {
			problems.push(`${where}: ${path} does not exist`)
			continue
		}
		if (loose) problems.push(`${where}: ${path} has a name outside parentheses`)
		const declared = names.length > 0 ? titles(files.read(path) ?? '') : []
		for (const name of names) {
			const parts = fragments(name)
			if (parts.length === 0) problems.push(`${where}: ${path} has an empty name "${name}"`)
			else if (!titled(declared, parts)) problems.push(`${where}: ${path} has no test "${name}"`)
		}
	}
	return problems
}

/** Every disagreement between the document and the files. */
function problems(document: string, files: Files): string[] {
	const found: string[] = []
	const flat = flatten(document)
	for (const mark of marks(flat)) {
		if (mark.kind === 'unknown') found.push(`unknown mark _${mark.text}_`)
	}
	for (const match of flat.matchAll(BRANCH)) found.push(`a branch: "${match[0]}"`)
	for (const { id, text } of invariants(document)) {
		const parsed = marks(text)
		if (!parsed.some(isStatus)) found.push(`${id}: no status`)
		for (const part of enforcedParts(text, parsed)) found.push(...citationProblems(id, part, files))
	}
	for (const status of entryPointStatuses(document)) {
		for (const part of status.split('; ')) {
			if (/^main: `[^`]+`(?:, `[^`]+`)*(?: \([^()]*\))?$/.test(part)) {
				found.push(...citationProblems('entry points', part, files))
			} else if (!/^Planned \([^()]+\)$/.test(part)) {
				found.push(`entry points: unknown status "${part}"`)
			}
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
		const parts = entries.flatMap(({ text }) => enforcedParts(text, marks(text)))
		expect(parts.length).toBeGreaterThan(150)
		const cited = parts.flatMap((part) => citations(part))
		expect(cited.filter(({ path }) => TEST_FILE.test(path)).length).toBeGreaterThan(300)
		expect(cited.flatMap(({ names }) => names).length).toBeGreaterThan(300)
		expect(entryPointStatuses(document).length).toBeGreaterThan(15)
		expect(titles(readFileSync(new URL('test-node/threat-model.test.ts', PACKAGE), 'utf8'))).toEqual([
			"the threat model's statuses",
			'reads the invariants, their enforced parts and their citations',
			'marks every part with a known status, and cites what exists',
			'reads only declared titles',
			'detects every kind of disagreement',
		])
	})

	it('marks every part with a known status, and cites what exists', () => {
		expect(problems(document, disk)).toEqual([])
	})

	it('reads only declared titles', () => {
		const source = [
			"// it('in a comment')",
			"describe('a suite', () => {",
			"\tit.each([['a', 1]])('each %s of %i', () => { expect('in a body').toBe('x') })",
			'\tit.skipIf(process.env.CI === "1")(`a ${"template"} title`, () => {})',
			"\ttest('it\\'s escaped', () => /'/.test(\"x\"))",
			"\tdescribe.each([1])('nested %i', () => {})",
			"\tit.each<[string, (h: H) => Promise<void>]>([['a', f]])('typed %s', async () => {})",
			'})',
		].join('\n')
		expect(titles(source)).toEqual([
			'a suite',
			'each %s of %i',
			`a ${HOLE} title`,
			"it's escaped",
			'nested %i',
			'typed %s',
		])
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
			'| Admin | R2 | main |',
			'| Other | R2 | Planned (later) and more |',
			'',
			'## Invariants',
			'',
			'- **EX-1: kept.** _Enforced (main):_ `src/a.ts`, `src/dir/*.ts`, `wrangler.jsonc`; `test/a.test.ts` ("EX-1:',
			'  holds", "two … parts", "a \\"quoted\\" one", "a (parenthesized) one", "first half"), migration `0001_init`.',
			'- **EX-2: missing.** _Enforced (main):_ `src/gone.ts`; `test/a.test.ts` ("no such test"), migration `0002_gone`.',
			'- **EX-3: planned.** _Planned (later):_ `src/gone.ts`. _Gap:_ untested.',
			'- **EX-4: from a branch.** _Implemented on branch `kopje/x`:_ `src/a.ts`, from kopje/y/z.',
			'- **EX-5: a comma.** _Enforced',
			'  (main):_ `test/a.test.ts`, "EX-1: holds". _Retired (merged into EX-1)._ `src/gone.ts`.',
			'- **EX-6: no status.** `src/a.ts`.',
			'- **EX-7: two parts.** _Enforced (main)_ for one: `src/a.ts`. _Planned (B9)_ for the other: `src/gone.ts`.',
			'  _Enforced (main)_ for a third: `test/a.test.ts` ("missing as well").',
			'- **EX-8: names that escape.** _Enforced (main):_ `test/a.test.ts` ("only in a comment", "alpha … omega",',
			'  "", "…", "two … one"). _Enforced (main)_ with no citation at all. _Enforced (main):_ `package.json`',
			'  and `src/gone.json`.',
			'',
			'## Accepted risks',
			'',
			'Text _italic text_ here, and `packages/kopje/test` is a path.',
		].join('\n')
		const files: Record<string, string> = {
			'src/a.ts': '',
			'src/dir/b.ts': '',
			'wrangler.jsonc': '',
			'package.json': '',
			'migrations/0001_init.sql': '',
			'test/a.test.ts': [
				'// only in a comment',
				"it('EX-1: holds')",
				"it('two halves, and parts')",
				'it("a \\"quoted\\" one")',
				"it('a (parenthesized) one')",
				"it('the first half of a title')",
				"it('alpha')",
				"it('omega')",
			].join('\n'),
		}
		const fake: Files = {
			read: (path) => files[path],
			exists: (path) => Object.keys(files).some((name) => wildcard(path).test(name)),
		}
		expect(problems(fixture, fake)).toEqual([
			'unknown mark _Implemented on branch `kopje/x`:_',
			'unknown mark _italic text_',
			'a branch: "kopje/setup"',
			'a branch: "on branch"',
			'a branch: "kopje/x"',
			'a branch: "kopje/y/z"',
			'EX-2: src/gone.ts does not exist',
			'EX-2: test/a.test.ts has no test "no such test"',
			'EX-2: migrations/0002_gone.sql does not exist',
			'EX-4: no status',
			'EX-5: test/a.test.ts has a name outside parentheses',
			'EX-6: no status',
			'EX-7: test/a.test.ts has no test "missing as well"',
			'EX-8: test/a.test.ts has no test "only in a comment"',
			'EX-8: test/a.test.ts has no test "alpha … omega"',
			'EX-8: test/a.test.ts has an empty name ""',
			'EX-8: test/a.test.ts has an empty name "…"',
			'EX-8: test/a.test.ts has no test "two … one"',
			'EX-8: an enforced part cites no file: "with no citation at all."',
			'EX-8: src/gone.json does not exist',
			'entry points: src/gone.ts does not exist',
			'entry points: unknown status "branch `kopje/setup`: `src/a.ts`"',
			'entry points: unknown status "main"',
			'entry points: unknown status "Planned (later) and more"',
		])
	})
})
