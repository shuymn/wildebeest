import { CARD_CONCURRENCY, CARD_OEMBED_BODY_LIMIT } from '../src/federation/link-cards'
import { CARD_OUTPUT_MAX_UNITS } from '../src/federation/link-details'
import { WEB_PAGE_BODY_LIMIT, WEB_PAGE_URL_LIMIT } from '../src/federation/web-page'
import { SCAN_LIMITS } from '../src/platform/html-scan'
import {
	CARD_EMBED_SRC_BYTES,
	CARD_LANGUAGE_BYTES,
	CARD_OPTIONAL_URL_LIMIT,
	CARD_TEXTS,
	OEMBED_TEMPLATE_BYTES,
} from '../src/platform/stored-bounds'

// The cron rounds' memory models (RES-6), computed from the bounds: V8's sizes estimate each value (a heap number, a
// string of n units, an array of n elements, an object of n properties), each at the worst shape its bound allows.

function v8Model(value: unknown): number {
	let bytes = 0
	const stack: unknown[] = [value]
	while (stack.length > 0) {
		const node = stack.pop()
		if (typeof node === 'string') {
			bytes += 16 + 2 * node.length
		} else if (typeof node === 'number') {
			bytes += Number.isInteger(node) && Math.abs(node) < 2 ** 30 ? 0 : 16
		} else if (Array.isArray(node)) {
			bytes += 16 + 8 * node.length
			stack.push(...(node as unknown[]))
		} else if (typeof node === 'object' && node !== null) {
			const entries = Object.entries(node)
			bytes += 24 + 16 * entries.length
			for (const [key, child] of entries) {
				stack.push(key, child)
			}
		}
	}
	return bytes
}

// The worst parsed value of a JSON text of `units` code units, over the shapes that maximize each estimate (nested
// arrays, checked to be the worst).
function worstParsed(units: number): number {
	const fill = (open: string, item: string, close: string) =>
		`${open}${Array.from({ length: Math.floor((units - open.length - close.length + 1) / (item.length + 1)) }, () => item).join(',')}${close}`
	const depth = Math.floor(units / 2)
	const shapes = {
		nested: `${'['.repeat(depth)}${']'.repeat(depth)}`,
		arrays: fill('[', '[]', ']'),
		objects: fill('[', '{}', ']'),
		strings: fill('[', '""', ']'),
		doubles: fill('[', '0.5', ']'),
		keys: fill('{', '"":0', '}'),
	}
	const parsed: Record<string, number> = {}
	for (const [name, text] of Object.entries(shapes)) {
		if (text.length > units) {
			throw new Error(`${name} is longer than ${units} units`)
		}
		parsed[name] = v8Model(JSON.parse(text))
	}
	const worst = Math.max(...Object.values(parsed))
	if (parsed.nested !== worst) {
		throw new Error('the nested shape is not the worst')
	}
	return worst
}

// The memory model of one link card claim (AM10, AM14), held CARD_CONCURRENCY times at once: the larger of its two
// phases, which never overlap (the page's scan is dropped before the endpoint chain, the endpoint's buffers before the
// cached path's page chain).
// - The page phase: the body prefix (bytes), the scan's strings (UTF-16 code units, two bytes each, links included),
//   one JSON-LD script being parsed (its text, decoded) and its parsed value. Scripts are parsed one at a time and
//   each is dropped once its fields are read (link-details.ts structuredData).
// - The oEmbed phase: the body buffer (limit + 1) and its copy (readBodyPrefix), the decoded text, its parsed value
//   (rejected shapes included: the caps are judged after JSON.parse), the iframe capture's input (a string of the
//   document, counted apart from the worst parsed shape) and its captured attributes, the page's fields retained at
//   their stored bounds with the endpoint and its template, and the expanded endpoint URL.
// Not counted: lol-html's native buffers (its 3 MiB limit), JSON.parse's internals and htmlparser2's parser state
// (its transient slices and stack).
export function linkCardRoundMemory() {
	const units = SCAN_LIMITS.jsonLdChars
	const scriptParsed = worstParsed(units)
	const page = WEB_PAGE_BODY_LIMIT + 2 * CARD_OUTPUT_MAX_UNITS + 2 * units + scriptParsed
	// The oEmbed body is UTF-8: at most one code unit a byte.
	const body = CARD_OEMBED_BODY_LIMIT
	const documentParsed = worstParsed(body)
	const captured = 3 * v8Model('a'.repeat(CARD_EMBED_SRC_BYTES))
	const retained =
		CARD_TEXTS.title -
		2 +
		(CARD_TEXTS.description - 2) +
		(CARD_TEXTS.author_name - 2) +
		(CARD_TEXTS.provider_name - 2) +
		2 * CARD_OPTIONAL_URL_LIMIT +
		CARD_LANGUAGE_BYTES +
		24 +
		CARD_EMBED_SRC_BYTES +
		WEB_PAGE_URL_LIMIT +
		OEMBED_TEMPLATE_BYTES
	const oembed =
		body + 1 + body + 2 * body + documentParsed + 2 * body + captured + 2 * retained + 2 * WEB_PAGE_URL_LIMIT
	const claim = Math.max(page, oembed)
	return { scriptParsed, page, documentParsed, retained, oembed, claim, round: CARD_CONCURRENCY * claim }
}
