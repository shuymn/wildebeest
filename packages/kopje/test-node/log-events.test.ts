import { readdirSync, readFileSync } from 'node:fs'

import type { Node } from 'oxc-parser'
import { describe, expect, it } from 'vitest'

import { guardFixtures, lineOf, parse, sources, walk, type Source } from './source-scan.js'

// The shape of Kopje's log events (docs/observability.md; DATA-5 in docs/threat-model.md). A bounded syntactic guard,
// not data-flow enforcement: it reads each log call in src/ and checks what the call itself spells out.
//
// - A direct call, `console.log | warn | error({ event: 'kopje.…', ...fields })`, takes exactly one argument. A
//   recognized sink, `this.#log(entry, level?)` or `(x.log ?? sink)(entry, level?)`, takes the entry and an optional
//   level literal, 'warn' or 'error'. The entry is an object literal whose first property is `event`, a string literal.
// - A name is `kopje.<area>.<what>[.<step>…]` in lowercase words joined by `_`, with an area of AREAS, or one of
//   LEGACY_NAMES. An event at the error level names its failure (`failed`, `unavailable` or `error`), and an event
//   that names one is logged at warn or error.
// - No field is a raw message (`errorMessage(…)`, `….message`, `String(…)`), a request URL or path (`c.req.path`,
//   `c.req.url`, `request.url`) or a raw error (`error`).
// - `console` is used for nothing else; EXCEPTIONS lists the reviewed sites that do otherwise.

const AREAS = new Set([
	'activity',
	'admin',
	'announcements',
	'authorize',
	'backup',
	'config',
	'cutover',
	'delivery',
	'emoji',
	'error',
	'field_links',
	'inbox',
	'jobs',
	'link_cards',
	'maintenance',
	'media',
	'presenter',
	'push',
	'queue',
	'quote',
	'scheduled',
	'setup',
	'snapshot',
	'spool',
	'store',
	'stream',
])
const NAME = /^kopje\.([a-z0-9_]+)(\.[a-z0-9_]+)+$/
const FAILURE_WORDS = new Set(['failed', 'unavailable', 'error'])

// Names from before the naming rule, kept because docs and operators' queries use them. Frozen: it may only shrink, and
// the test fails for a listed name that no longer occurs. A new event follows the rule instead.
const LEGACY_NAMES: ReadonlySet<string> = new Set([
	'kopje.announcements.row-cap-exceeded',
	'kopje.authorize.access-denied',
	'kopje.config.invalid',
	'kopje.error',
	'kopje.maintenance.backlog-full',
	'kopje.maintenance.queue-missing',
	'kopje.maintenance.rate-limited',
	'kopje.media.type_refused',
	'kopje.presenter.row-cap-exceeded',
	'kopje.queue.unknown',
	'kopje.snapshot.save-failed',
	'kopje.spool.backlog-full',
	'kopje.spool.handed-off',
	'kopje.spool.handoff-check.failed',
	'kopje.spool.metrics-unavailable',
	'kopje.store.cutover.discard-kept',
	'kopje.store.hold.persist-failed',
	'kopje.store.import.chunk-failed',
	'kopje.store.import.reset-done',
	'kopje.store.import.verify-failed',
	'kopje.store.snapshot.unreadable',
	'kopje.stream.capture-truncated',
	'kopje.stream.journal-full',
	'kopje.stream.payload-skipped',
	'kopje.stream.register-failed',
	'kopje.stream.send-failed',
	'kopje.stream.tick-failed',
	'kopje.stream.turn-failed',
	'kopje.stream.turn-request-failed',
])

// Reviewed sites that call `console` otherwise, by file and the call's text.
const EXCEPTIONS: Record<string, string> = {
	// The default sink: the level is the sink's argument, checked at each sink call.
	'src/platform/log.ts: console[level ?? ': 'the default injected sink',
	// The event names are the literals passed to nextDueOf, which the guard checks as names (NEXT_DUE_EVENTS).
	'src/jobs/deliver.ts: console.error({ event, ...errorFields(error) })': 'an event name passed as a parameter',
}
// Calls whose argument at the given index is an event name for an excepted site.
const NAME_ARGUMENTS: Record<string, number> = { nextDueOf: 1 }

const LEVELS = new Set(['warn', 'error'])
const DIRECT = new Set(['log', 'warn', 'error', 'info', 'debug'])
const FORBIDDEN_MEMBERS = new Set(['c.req.path', 'c.req.url', 'request.url'])

// The key of a member access when it is static: `x.key`, `x['key']` or x[`key`]; else null.
function memberKey(node: Node): string | null {
	if (node.type !== 'MemberExpression') {
		return null
	}
	const key = node.property
	if (!node.computed) {
		return key.type === 'Identifier' ? key.name : null
	}
	if (key.type === 'Literal' && typeof key.value === 'string') {
		return key.value
	}
	return key.type === 'TemplateLiteral' && key.expressions.length === 0 ? (key.quasis[0]?.value.cooked ?? null) : null
}

// A chain of static member accesses from an identifier, dotted (`c.req['path']` is `c.req.path`); else null.
function memberChain(node: Node): string | null {
	if (node.type === 'Identifier') {
		return node.name
	}
	const key = memberKey(node)
	const object = node.type === 'MemberExpression' ? memberChain(node.object) : null
	return key === null || object === null ? null : `${object}.${key}`
}

type LogEvent = { path: string; line: number; name: string; level: 'log' | 'warn' | 'error' }

type Scan = { findings: string[]; events: LogEvent[]; exceptions: Set<string>; offRule: Set<string> }

function scan(files: readonly Source[], legacy: ReadonlySet<string> = LEGACY_NAMES): Scan {
	const findings: string[] = []
	const events: LogEvent[] = []
	const exceptions = new Set<string>()
	for (const source of files) {
		const { program } = parse(source)
		const text = (node: Node) => source.text.slice(node.start, node.end)
		const at = (node: Node) => `${source.path}:${lineOf(source.text, node.start)}`
		const excepted = (node: Node) => {
			const key = Object.keys(EXCEPTIONS).find((k) => `${source.path}: ${text(node)}`.startsWith(k))
			if (key !== undefined) {
				exceptions.add(key)
			}
			return key !== undefined
		}
		const handled = new Set<Node>()
		walk(program, (node) => {
			if (node.type !== 'CallExpression') {
				return
			}
			const callee = node.callee
			if (callee.type === 'Identifier' && NAME_ARGUMENTS[callee.name] !== undefined) {
				const name = node.arguments[NAME_ARGUMENTS[callee.name] ?? -1]
				if (name?.type === 'Literal' && typeof name.value === 'string') {
					events.push({ path: source.path, line: lineOf(source.text, name.start), name: name.value, level: 'error' })
				} else {
					findings.push(`${at(node)}: the event name passed to ${callee.name} is not a string literal`)
				}
				return
			}
			let form: 'direct' | 'sink' | null = null
			let level: LogEvent['level'] = 'log'
			if (
				callee.type === 'MemberExpression' &&
				callee.object.type === 'Identifier' &&
				callee.object.name === 'console'
			) {
				handled.add(callee.object)
				if (excepted(node)) {
					return
				}
				const method = !callee.computed && callee.property.type === 'Identifier' ? callee.property.name : null
				if (method === null || !DIRECT.has(method)) {
					findings.push(`${at(node)}: console call other than log, warn or error`)
					return
				}
				if (method === 'info' || method === 'debug') {
					findings.push(`${at(node)}: console.${method}; use log, warn or error`)
					return
				}
				form = 'direct'
				level = method as LogEvent['level']
			} else if (
				(callee.type === 'MemberExpression' &&
					callee.object.type === 'ThisExpression' &&
					callee.property.type === 'PrivateIdentifier' &&
					callee.property.name === 'log') ||
				(callee.type === 'LogicalExpression' &&
					callee.operator === '??' &&
					callee.left.type === 'MemberExpression' &&
					!callee.left.computed &&
					callee.left.property.type === 'Identifier' &&
					callee.left.property.name === 'log')
			) {
				form = 'sink'
			}
			if (form === null) {
				return
			}
			const [entry, levelArgument, ...rest] = node.arguments
			if (form === 'direct' ? levelArgument !== undefined : rest.length > 0) {
				findings.push(`${at(node)}: too many arguments`)
			}
			if (form === 'sink' && levelArgument !== undefined) {
				if (
					levelArgument.type === 'Literal' &&
					typeof levelArgument.value === 'string' &&
					LEVELS.has(levelArgument.value)
				) {
					level = levelArgument.value as LogEvent['level']
				} else {
					findings.push(`${at(node)}: the level is not 'warn' or 'error'`)
				}
			}
			if (entry?.type !== 'ObjectExpression') {
				findings.push(`${at(node)}: the entry is not an object literal`)
				return
			}
			const first = entry.properties[0]
			if (
				first?.type !== 'Property' ||
				first.computed ||
				first.key.type !== 'Identifier' ||
				first.key.name !== 'event' ||
				first.value.type !== 'Literal' ||
				typeof first.value.value !== 'string'
			) {
				findings.push(`${at(node)}: the first property is not an event name literal`)
			} else {
				events.push({ path: source.path, line: lineOf(source.text, node.start), name: first.value.value, level })
			}
			walk(entry, (inner) => {
				if (
					inner.type === 'CallExpression' &&
					inner.callee.type === 'Identifier' &&
					(inner.callee.name === 'errorMessage' || inner.callee.name === 'String')
				) {
					findings.push(`${at(inner)}: logs ${inner.callee.name}(…)`)
				} else if (inner.type === 'MemberExpression' && memberKey(inner) === 'message') {
					findings.push(`${at(inner)}: logs a message (${text(inner)})`)
				} else if (inner.type === 'MemberExpression' && FORBIDDEN_MEMBERS.has(memberChain(inner) ?? '')) {
					findings.push(`${at(inner)}: logs ${memberChain(inner)}`)
				} else if (inner.type === 'Property' && inner.value.type === 'Identifier' && inner.value.name === 'error') {
					findings.push(`${at(inner)}: logs a raw error`)
				}
			})
		})
		walk(program, (node) => {
			if (node.type === 'Identifier' && node.name === 'console' && !handled.has(node)) {
				findings.push(`${at(node)}: uses console other than as a log call`)
			}
		})
	}
	const offRule = new Set<string>()
	for (const event of events) {
		const where = `${event.path}:${event.line}: ${event.name}`
		const match = NAME.exec(event.name)
		const failure = event.name.split(/[._-]/).some((word) => FAILURE_WORDS.has(word))
		// A legacy name keeps its spelling, not a level below warn for a failure.
		if (event.level === 'log' && failure) {
			findings.push(`${where} names a failure but is logged below warn`)
		}
		let problem: string | null = null
		if (match === null || !AREAS.has(match[1] ?? '')) {
			problem = 'is not kopje.<area>.<what> in snake_case'
		} else if (event.level === 'error' && !failure) {
			problem = 'is logged at error but names no failure'
		}
		if (problem !== null) {
			offRule.add(event.name)
			if (!legacy.has(event.name)) {
				findings.push(`${where} ${problem}`)
			}
		}
	}
	return { findings, events, exceptions, offRule }
}

const find = (files: readonly Source[]) => scan(files).findings

const SOURCES = sources('src')
const SCAN = scan(SOURCES)
const NAMES = new Set(SCAN.events.map((e) => e.name))

// Event references in the docs: inline code spans (fenced blocks left out) holding `kopje.` and at least two more
// segments (`*` counting as one); one ending in `.*` names a family, which some event must start with.
const NOT_EVENTS: ReadonlySet<string> = new Set([])

function docReferences(text: string): string[] {
	const prose = text.replace(/^```[^\n]*\n[\s\S]*?^```$/gm, '')
	return [...prose.matchAll(/`([^`\n]+)`/g)].flatMap((span) =>
		[...(span[1] ?? '').matchAll(/\bkopje(?:\.[A-Za-z0-9_-]+)+\.\*|\bkopje(?:\.[A-Za-z0-9_-]+){2,}/g)].map((m) => m[0])
	)
}

function unknownReferences(text: string, names: ReadonlySet<string>): string[] {
	return docReferences(text).filter((reference) => {
		if (NOT_EVENTS.has(reference)) {
			return false
		}
		if (reference.endsWith('.*')) {
			const prefix = reference.slice(0, -1)
			return ![...names].some((name) => name.startsWith(prefix))
		}
		return !names.has(reference)
	})
}

const DOCS = readdirSync(new URL('../docs/', import.meta.url))
	.filter((name) => name.endsWith('.md'))
	.sort()
	.map((name) => ({ name, text: readFileSync(new URL(`../docs/${name}`, import.meta.url), 'utf8') }))

describe('log events', () => {
	it('sees the log calls', () => {
		expect(SCAN.events.length).toBeGreaterThan(100)
		expect(NAMES).toContain('kopje.store.upgrade.failed')
	})

	it('follows the shape, naming and field rules', () => {
		expect(SCAN.findings).toEqual([])
	})

	it('lists only legacy names that still occur and still break the rule', () => {
		expect([...LEGACY_NAMES].filter((name) => !NAMES.has(name))).toEqual([])
		expect([...LEGACY_NAMES].filter((name) => !SCAN.offRule.has(name))).toEqual([])
	})

	it('uses every exception', () => {
		expect(Object.keys(EXCEPTIONS).filter((key) => !SCAN.exceptions.has(key))).toEqual([])
	})

	it('names in the docs only events the code logs', () => {
		expect(DOCS.length).toBeGreaterThan(5)
		const found = DOCS.flatMap(({ name, text }) => unknownReferences(text, NAMES).map((r) => `docs/${name}: ${r}`))
		expect(found).toEqual([])
		const references = DOCS.flatMap(({ text }) => docReferences(text))
		expect(references).toContain('kopje.store.upgrade.failed')
	})

	it('flags a misspelled doc reference and passes a family, a fenced block and a short name', () => {
		const names = new Set(['kopje.store.upgrade.failed', 'kopje.backup.succeeded'])
		const text = [
			'See `kopje.store.upgrade.faild` and `event = kopje.backup.succeded`.',
			'The `kopje.backup.*` family, `kopje.store.upgrade.failed`, and `kopje.version`.',
			'```text',
			'`kopje.not.real.event`',
			'```',
		].join('\n')
		expect(unknownReferences(text, names)).toEqual(['kopje.store.upgrade.faild', 'kopje.backup.succeded'])
		expect(unknownReferences('`kopje.media.*`', names)).toEqual(['kopje.media.*'])
	})

	guardFixtures(find, {
		flagged: {
			'a string message': [
				"console.warn('kopje.store.x failed')",
				'src/domain/probe.ts:1: the entry is not an object literal',
			],
			'a second argument to console': [
				"console.error({ event: 'kopje.store.x_failed' }, 'error')",
				'src/domain/probe.ts:1: too many arguments',
			],
			'an event that is not first': [
				"console.log({ id, event: 'kopje.store.x' })",
				'src/domain/probe.ts:1: the first property is not an event name literal',
			],
			'an event name from a variable': [
				'console.log({ event: name })',
				'src/domain/probe.ts:1: the first property is not an event name literal',
			],
			'a raw message': [
				"console.error({ event: 'kopje.store.x_failed', error: errorMessage(error) })",
				'src/domain/probe.ts:1: logs errorMessage(…)',
			],
			'a message member': [
				"console.error({ event: 'kopje.store.x_failed', detail: e.message })",
				'src/domain/probe.ts:1: logs a message (e.message)',
			],
			'String of an error': [
				"console.error({ event: 'kopje.store.x_failed', detail: String(e) })",
				'src/domain/probe.ts:1: logs String(…)',
			],
			'a raw error': [
				"console.error({ event: 'kopje.store.x_failed', error })",
				'src/domain/probe.ts:1: logs a raw error',
			],
			'the request path': [
				"console.error({ event: 'kopje.admin.error', path: c.req.path })",
				'src/domain/probe.ts:1: logs c.req.path',
			],
			'a computed message member': [
				"console.error({ event: 'kopje.store.x_failed', detail: error['message'] })",
				"src/domain/probe.ts:1: logs a message (error['message'])",
			],
			'a computed request path': [
				"console.error({ event: 'kopje.admin.error', path: c.req['path'] })",
				'src/domain/probe.ts:1: logs c.req.path',
			],
			'a computed request URL': [
				"console.warn({ event: 'kopje.inbox.refused', url: request[`url`] })",
				'src/domain/probe.ts:1: logs request.url',
			],
			'the request URL': [
				"console.warn({ event: 'kopje.inbox.refused', url: request.url })",
				'src/domain/probe.ts:1: logs request.url',
			],
			'a kebab name not on the list': [
				"console.warn({ event: 'kopje.stream.new-thing' })",
				'src/domain/probe.ts:1: kopje.stream.new-thing is not kopje.<area>.<what> in snake_case',
			],
			'an unknown area': [
				"console.log({ event: 'kopje.widget.done' })",
				'src/domain/probe.ts:1: kopje.widget.done is not kopje.<area>.<what> in snake_case',
			],
			'a two-segment name': [
				"console.log({ event: 'kopje.store' })",
				'src/domain/probe.ts:1: kopje.store is not kopje.<area>.<what> in snake_case',
			],
			'an error-level event naming no failure': [
				"console.error({ event: 'kopje.store.done' })",
				'src/domain/probe.ts:1: kopje.store.done is logged at error but names no failure',
			],
			'console.info': [
				"console.info({ event: 'kopje.store.x' })",
				'src/domain/probe.ts:1: console.info; use log, warn or error',
			],
			'a computed console call': [
				"console[level]({ event: 'kopje.store.x' })",
				'src/domain/probe.ts:1: console call other than log, warn or error',
			],
			'console passed on': ['const log = console.log', 'src/domain/probe.ts:1: uses console other than as a log call'],
			'a sink with a third argument': [
				"this.#log({ event: 'kopje.store.x_failed' }, 'error', 1)",
				'src/domain/probe.ts:1: too many arguments',
			],
			'a sink with a level that is not a literal': [
				"this.#log({ event: 'kopje.store.x_failed' }, level)",
				"src/domain/probe.ts:1: the level is not 'warn' or 'error'",
			],
			'a sink logging a raw message': [
				"this.#log({ event: 'kopje.store.x_failed', error: errorMessage(error) }, 'error')",
				'src/domain/probe.ts:1: logs errorMessage(…)',
			],
			'a conditional sink with a string entry': [
				"(deps.log ?? consoleSink)('kopje.backup.error')",
				'src/domain/probe.ts:1: the entry is not an object literal',
			],
			'a conditional sink at error naming no failure': [
				"(deps.log ?? consoleSink)({ event: 'kopje.backup.done' }, 'error')",
				'src/domain/probe.ts:1: kopje.backup.done is logged at error but names no failure',
			],
			'a failure at info': [
				"this.#log({ event: 'kopje.store.import.reset_failed' })",
				'src/domain/probe.ts:1: kopje.store.import.reset_failed names a failure but is logged below warn',
			],
			'a legacy failure at info': [
				"this.#log({ event: 'kopje.store.import.chunk-failed', code })",
				'src/domain/probe.ts:1: kopje.store.import.chunk-failed names a failure but is logged below warn',
			],
			'a sink at info naming a bad name': [
				"this.#log({ event: 'kopje.store.Thing' })",
				'src/domain/probe.ts:1: kopje.store.Thing is not kopje.<area>.<what> in snake_case',
			],
			'a variable event name passed to nextDueOf': [
				'nextDueOf(round, name)',
				'src/domain/probe.ts:1: the event name passed to nextDueOf is not a string literal',
			],
			'a template event name passed to nextDueOf': [
				'nextDueOf(round, `kopje.delivery.${step}.failed`)',
				'src/domain/probe.ts:1: the event name passed to nextDueOf is not a string literal',
			],
			'no event name passed to nextDueOf': [
				'nextDueOf(round)',
				'src/domain/probe.ts:1: the event name passed to nextDueOf is not a string literal',
			],
			'a bad event name passed to nextDueOf': [
				"nextDueOf(round, 'kopje.delivery.round-failed')",
				'src/domain/probe.ts:1: kopje.delivery.round-failed is not kopje.<area>.<what> in snake_case',
			],
		},
		passed: {
			'a direct call': "console.warn({ event: 'kopje.store.unavailable', reason, ...errorFields(error) })",
			'an error-level failure': "console.error({ event: 'kopje.scheduled.status.failed', id, recorded: true })",
			'a failure word inside a segment': "console.error({ event: 'kopje.backup.record_failed', ...errorFields(e) })",
			'a sink at a level': "this.#log({ event: 'kopje.store.upgrade.failed', bookmark, detail }, 'error')",
			'a sink at info': "this.#log({ event: 'kopje.store.upgrade.done', applied })",
			'a conditional sink': "(deps.log ?? consoleSink)({ event: 'kopje.backup.error', ...errorFields(e) }, 'error')",
			'a dynamic member': "console.log({ event: 'kopje.store.x', size: sizes[key] })",
			'a message elsewhere': "const text = error.message\nconsole.log({ event: 'kopje.store.x', size: text.length })",
			'console in a comment': "// console.log('x')\nconsole.log({ event: 'kopje.store.x' })",
			'an error field from errorFields': "console.error({ event: 'kopje.store.x_failed', ...errorFields(error) })",
		},
	})
})
