import { decodeHTML, decodeHTMLAttribute } from 'entities/decode'

// A bounded scan of a fetched HTML page (federation/web-page.ts, NET-3) for what Mastodon's link verification and link
// cards read: rel=me links, <link> elements, <meta> properties, the first <title>, the root's lang and JSON-LD scripts.
// It runs on workerd's HTMLRewriter (lol-html): a spec tokenizer with a tree-builder simulator that tracks namespaces,
// foreign content and integration points, streaming natively. Facts it rests on are pinned by
// test/html-rewriter-facts.test.ts: attribute values and text chunks come raw (references undecoded, CR kept), the
// first of duplicate attributes wins, an end tag handler runs only for an explicit end tag, a meta charset is not
// re-sniffed, an unsupported label fails construction, and a parsing ambiguity or the 3 MiB buffer limit fails the
// stream. Any failure is a failure of the whole scan: nothing partial is returned.
//
// Kopje follows lol-html where it differs from Mastodon's parser (Nokogiri's HTML5 parser, scripting off):
//   - lol-html parses <noscript> as raw text (scripting on), so markup a scripting-off parser puts in a comment can
//     surface as elements. No rel=me after the first <noscript> start tag is collected (relMeAfterNoscript); card
//     metadata after one may differ from Mastodon's.
//   - lol-html does not model the "in select" insertion mode, where a scripting-off parser ignores <a> and <link>
//     start tags: no rel=me inside a <select> whose end tag has not been seen is collected (relMeInSelect).
//   - nor does it model <frameset>, which replaces the body (or makes later markup ignored), and it does not see one
//     inside a <noscript>: a page with "<frameset" anywhere in its bytes returns no rel=me (relMeWithFrameset).
//   - it enters SVG for an <svg> inside <math> (and MathML for the reverse), where the spec keeps the outer namespace:
//     no rel=me after an <svg> start tag while a <math> is open, or the reverse, is collected
//     (relMeAfterNestedForeign).
//   - only elements in the HTML namespace count; SVG and MathML elements are skipped, and HTML elements inside an
//     integration point are HTML. lol-html reports an integration point element itself (an SVG <title>, <desc> or
//     <foreignObject>, a MathML <mi>) as XHTML, so no <title> after the first <svg> or <math> start tag is taken.
//   - lol-html keeps a stack of open elements within its 3 MiB: some 50,000 unclosed elements fail the scan (memory).
//   - a capture (title, JSON-LD) cut by the end of the input is dropped; a start tag cut by it is never emitted.

export type ScanLimits = {
	relMe: number
	links: number
	metas: number
	jsonLd: number
	// Raw UTF-16 code units of one JSON-LD script, kept undecoded.
	jsonLdChars: number
	// Decoded UTF-16 code units of an href, a meta content or the title.
	valueChars: number
	// Decoded UTF-16 code units of a meta property or name, or a link type.
	keyChars: number
	relTokens: number
	relTokenChars: number
	langChars: number
}

// The defaults, and the most a caller may ask for: limits passed to scanHtml only lower them.
export const SCAN_LIMITS: Readonly<ScanLimits> = Object.freeze({
	relMe: 32,
	links: 64,
	metas: 128,
	jsonLd: 4,
	jsonLdChars: 32_768,
	valueChars: 2048,
	keyChars: 128,
	relTokens: 16,
	relTokenChars: 64,
	langChars: 64,
})

// Raw UTF-16 code units of an attribute value or the title text read before decoding; past it the value is dropped
// whole. A character reference never decodes to more code units than it spans, so this bounds decoding work only.
export const RAW_VALUE_CHARS = 8192

// The most UTF-16 code units a scan returns in its strings, from SCAN_LIMITS (test/html-scan.test.ts recomputes it):
// relMe 32 × 2,048 + links 64 × (2,048 + 128 + 16 × 64) + metas 128 × (128 + 128 + 2,048) + title 2,048 + lang 64 +
// jsonLd 4 × 32,768 = 698,432. At most 3 UTF-8 bytes and 6 JSON-escaped bytes per unit.
export function outputMaxUnits(limits: ScanLimits = SCAN_LIMITS): number {
	return (
		limits.relMe * limits.valueChars +
		limits.links * (limits.valueChars + limits.keyChars + limits.relTokens * limits.relTokenChars) +
		limits.metas * (2 * limits.keyChars + limits.valueChars) +
		limits.valueChars +
		limits.langChars +
		limits.jsonLd * limits.jsonLdChars
	)
}
export const OUTPUT_MAX_UNITS = outputMaxUnits()

export type PageLink = { rel: string[]; href: string | null; type: string | null }
export type PageMeta = { property: string | null; name: string | null; content: string | null }

export type PageScan = {
	// The first <html lang>, decoded.
	lang: string | null
	// The first HTML <title> whose end tag was seen, before any <svg> or <math>, decoded and untrimmed.
	title: string | null
	// The href of each <a> or <link> whose rel has the token "me", in document order; null when it is missing or past
	// its cap, the slot kept.
	relMe: (string | null)[]
	// Whether a rel=me candidate was skipped for following a <noscript> start tag, or for being inside a <select>.
	relMeAfterNoscript: boolean
	relMeInSelect: boolean
	// Whether the page has the bytes of a <frameset> start tag anywhere (a <noscript> included), which can replace the
	// body: then no rel=me is returned.
	relMeWithFrameset: boolean
	// Whether a rel=me candidate was skipped for following an <svg> inside a <math>, or the reverse.
	relMeAfterNestedForeign: boolean
	// Every <link>, rel tokens lowercased.
	links: PageLink[]
	// Every <meta> with a property or a name, both lowercased; first wins is the caller's rule.
	metas: PageMeta[]
	// The raw text of each completed <script type="application/ld+json"> (exact, case-sensitive), not decoded.
	jsonLd: string[]
	// What was not collected: candidates past a cap or in a refused context, and values past their bounds.
	dropped: { relMe: number; links: number; metas: number; jsonLd: number; values: number }
	// UTF-16 code units in the returned strings, at most OUTPUT_MAX_UNITS.
	outputUnits: number
	// Element handler calls and text chunks seen, for the work bounds.
	work: { elements: number; textChunks: number }
}

export type ScanFailure = { failed: 'ambiguity' | 'memory' | 'parser' }

const XHTML = 'http://www.w3.org/1999/xhtml'
const REL_SEPARATOR = /[\t\n\f\r ]+/
// Labels lol-html does not decode natively (not ASCII-compatible): transcoded to UTF-8 first.
const TRANSCODED = new Set(['utf-16le', 'utf-16be', 'iso-2022-jp'])

const asciiLower = (value: string) => value.replace(/[A-Z]+/g, (upper) => upper.toLowerCase())

// A raw attribute value or title text, normalized as the tokenizer would (CR and CRLF to LF, NUL to U+FFFD) and then
// decoded once, or null past RAW_VALUE_CHARS or `cap` decoded units. An encoded &#13; stays a CR.
function decoded(raw: string | null, cap: number, attribute: boolean): string | null {
	if (raw === null || raw.length > RAW_VALUE_CHARS) {
		return null
	}
	const normalized = raw.replace(/\r\n?/g, '\n').replaceAll('\0', '�')
	const value = attribute ? decodeHTMLAttribute(normalized) : decodeHTML(normalized)
	return value.length > cap ? null : value
}

function clamp(limits: Partial<ScanLimits> | undefined): ScanLimits {
	const out = { ...SCAN_LIMITS }
	for (const key of Object.keys(out) as (keyof ScanLimits)[]) {
		const given = limits?.[key]
		if (given !== undefined && Number.isFinite(given)) {
			out[key] = Math.max(0, Math.min(out[key], Math.floor(given)))
		}
	}
	return out
}

const FRAMESET = [0x66, 0x72, 0x61, 0x6d, 0x65, 0x73, 0x65, 0x74]

// Whether "<frameset" (ASCII case-insensitive) occurs in the bytes the rewriter reads: in a tag, a comment, a script
// or a noscript alike. O(n).
function hasFrameset(bytes: Uint8Array): boolean {
	for (let at = bytes.indexOf(0x3c); at >= 0; at = bytes.indexOf(0x3c, at + 1)) {
		let i = 0
		while (i < FRAMESET.length && ((bytes[at + 1 + i] ?? 0) | 0x20) === FRAMESET[i]) {
			i++
		}
		if (i === FRAMESET.length) {
			return true
		}
	}
	return false
}

// The rewriter's input in SCAN_CHUNK pieces, each after a turn of the event loop, so a deadline timer can abort a scan
// between them: given whole, the input is scanned in one native step that nothing interrupts.
const SCAN_CHUNK = 64 * 1024

function chunks(bytes: Uint8Array, signal: AbortSignal | undefined): ReadableStream<Uint8Array> {
	let offset = 0
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (offset > 0 && offset < bytes.byteLength) {
				await new Promise((resolve) => setTimeout(resolve, 0))
			}
			// Past an abort the drain has rejected already; the rest of the input is not read.
			if (signal?.aborted === true || offset >= bytes.byteLength) {
				controller.close()
				return
			}
			controller.enqueue(bytes.subarray(offset, offset + SCAN_CHUNK))
			offset += SCAN_CHUNK
		},
	})
}

function failureOf(error: unknown): ScanFailure {
	const message = error instanceof Error ? error.message : String(error)
	if (/ambigu/i.test(message)) {
		return { failed: 'ambiguity' }
	}
	return { failed: /memory/i.test(message) ? 'memory' : 'parser' }
}

// Scans `input` (the page's bytes from its BOM on) decoded as `charset.label`. The rewriter consumes all of it
// natively; every handler is synchronous, returns before reading attributes past a cap, reads at most 3 attributes
// and never iterates them. An abort of `signal` stops the drain and the collection, and the scan rejects with the
// signal's reason: a late or partial collection is never returned.
export async function scanHtml(
	input: Uint8Array,
	charset: { label: string; bomLength: number },
	limits?: Partial<ScanLimits>,
	signal?: AbortSignal
): Promise<PageScan | ScanFailure> {
	signal?.throwIfAborted()
	const caps = clamp(limits)
	const maxUnits = outputMaxUnits(caps)
	const scan: PageScan = {
		lang: null,
		title: null,
		relMe: [],
		relMeAfterNoscript: false,
		relMeInSelect: false,
		relMeWithFrameset: false,
		relMeAfterNestedForeign: false,
		links: [],
		metas: [],
		jsonLd: [],
		dropped: { relMe: 0, links: 0, metas: 0, jsonLd: 0, values: 0 },
		outputUnits: 0,
		work: { elements: 0, textChunks: 0 },
	}
	let afterNoscript = false
	// <select> start tags in the HTML namespace whose end tag has not been seen.
	let openSelects = 0
	// <svg> and <math> start tags whose end tag has not been seen, and whether one was seen inside the other.
	const openForeign = { svg: 0, math: 0 }
	let nestedForeign = false
	let afterForeign = false
	let langSeen = false
	// The first HTML title: its raw text while open, then done.
	let title: { raw: string; overflow: boolean } | null = null
	let titleDone = false
	let script: { raw: string; overflow: boolean } | null = null
	let broken = false

	// Adds `units` to the output, or refuses when the total would pass the maximum (never, under the caps).
	const fits = (units: number): boolean => {
		if (scan.outputUnits + units > maxUnits) {
			return false
		}
		scan.outputUnits += units
		return true
	}
	const value = (raw: string | null, cap: number, attribute = true): string | null => {
		const result = decoded(raw, cap, attribute)
		if (raw !== null && result === null) {
			scan.dropped.values++
		}
		return result
	}
	const relTokens = (element: Element): string[] | null => {
		const rel = value(element.getAttribute('rel'), RAW_VALUE_CHARS)
		if (rel === null) {
			return null
		}
		const tokens: string[] = []
		for (const token of rel.split(REL_SEPARATOR)) {
			if (tokens.length >= caps.relTokens) {
				break
			}
			if (token !== '' && token.length <= caps.relTokenChars) {
				tokens.push(asciiLower(token))
			}
		}
		return tokens
	}
	// Whether a rel=me candidate here is refused for its context, noted when it is.
	const refusedContext = (): boolean => {
		scan.relMeAfterNoscript ||= afterNoscript
		scan.relMeInSelect ||= openSelects > 0
		scan.relMeAfterNestedForeign ||= nestedForeign
		return afterNoscript || openSelects > 0 || nestedForeign
	}
	const addRelMe = (href: string | null) => {
		if (refusedContext() || scan.relMe.length >= caps.relMe) {
			scan.dropped.relMe++
		} else {
			scan.relMe.push(href !== null && fits(href.length) ? href : null)
		}
	}
	// Every handler is wrapped: a throw would fail the stream with no reason given, so it marks the scan broken.
	const guarded = <T>(handler: (node: T) => void) => {
		return (node: T) => {
			if (broken || signal?.aborted) {
				return
			}
			try {
				handler(node)
			} catch {
				broken = true
			}
		}
	}
	const counted = (handler: (element: Element) => void) =>
		guarded<Element>((element) => {
			scan.work.elements++
			if (element.namespaceURI === XHTML) {
				handler(element)
			}
		})

	const rewriter = new HTMLRewriter()
		.on('svg, math', {
			element: guarded<Element>((element) => {
				scan.work.elements++
				afterForeign = true
				const name = element.tagName === 'svg' ? 'svg' : 'math'
				if (openForeign[name === 'svg' ? 'math' : 'svg'] > 0) {
					nestedForeign = true
				}
				openForeign[name]++
				element.onEndTag(
					guarded((end: EndTag) => {
						if (end.name === name) {
							openForeign[name]--
						}
					})
				)
			}),
		})
		.on('noscript', {
			element: guarded<Element>(() => {
				scan.work.elements++
				afterNoscript = true
			}),
		})
		.on('select', {
			element: counted((element) => {
				openSelects++
				// An end tag that pops enclosing elements (</math> around an <mi><select>) runs their handlers too, under
				// its own name: only </select> closes a select here; otherwise it stays open, which only misses.
				element.onEndTag(
					guarded((end: EndTag) => {
						if (end.name === 'select') {
							openSelects--
						}
					})
				)
			}),
		})
		.on('a[rel]', {
			element: counted((element) => {
				if (scan.relMe.length >= caps.relMe) {
					// Whether it is rel=me is not read past the cap: counted as a candidate.
					scan.dropped.relMe++
					return
				}
				if (relTokens(element)?.includes('me')) {
					addRelMe(value(element.getAttribute('href'), caps.valueChars))
				}
			}),
		})
		.on('link', {
			element: counted((element) => {
				const relMeFull = scan.relMe.length >= caps.relMe
				const linksFull = scan.links.length >= caps.links
				if (linksFull) {
					scan.dropped.links++
				}
				if (linksFull && relMeFull) {
					return
				}
				const rel = relTokens(element) ?? []
				const href = value(element.getAttribute('href'), caps.valueChars)
				if (rel.includes('me')) {
					addRelMe(href)
				}
				if (linksFull) {
					return
				}
				const type = value(element.getAttribute('type'), caps.keyChars)
				const units = rel.reduce((sum, token) => sum + token.length, 0) + (href?.length ?? 0) + (type?.length ?? 0)
				if (fits(units)) {
					scan.links.push({ rel, href, type })
				} else {
					scan.dropped.links++
				}
			}),
		})
		.on('meta', {
			element: counted((element) => {
				if (scan.metas.length >= caps.metas) {
					scan.dropped.metas++
					return
				}
				const rawProperty = element.getAttribute('property')
				const rawName = element.getAttribute('name')
				if (rawProperty === null && rawName === null) {
					return
				}
				const property = value(rawProperty, caps.keyChars)
				const name = value(rawName, caps.keyChars)
				const content = value(element.getAttribute('content'), caps.valueChars)
				const entry = {
					property: property === null ? null : asciiLower(property),
					name: name === null ? null : asciiLower(name),
					content,
				}
				if (fits((property?.length ?? 0) + (name?.length ?? 0) + (content?.length ?? 0))) {
					scan.metas.push(entry)
				} else {
					scan.dropped.metas++
				}
			}),
		})
		.on('html[lang]', {
			element: counted((element) => {
				if (langSeen) {
					return
				}
				langSeen = true
				const lang = value(element.getAttribute('lang'), caps.langChars)
				if (lang !== null && fits(lang.length)) {
					scan.lang = lang
				}
			}),
		})
		.on('title', {
			element: counted((element) => {
				if (titleDone || title !== null || afterForeign) {
					return
				}
				const open = { raw: '', overflow: false }
				title = open
				element.onEndTag(
					guarded(() => {
						titleDone = true
						title = null
						const text = open.overflow ? null : decoded(open.raw, caps.valueChars, false)
						if (text === null || !fits(text.length)) {
							scan.dropped.values++
						} else {
							scan.title = text
						}
					})
				)
			}),
			text: guarded<Text>((chunk) => {
				scan.work.textChunks++
				const open = title
				if (open === null || open.overflow) {
					return
				}
				if (open.raw.length + chunk.text.length > RAW_VALUE_CHARS) {
					open.overflow = true
					open.raw = ''
				} else {
					open.raw += chunk.text
				}
			}),
		})
		.on('script', {
			element: counted((element) => {
				if (decoded(element.getAttribute('type'), caps.keyChars, true) !== 'application/ld+json') {
					return
				}
				if (scan.jsonLd.length >= caps.jsonLd) {
					scan.dropped.jsonLd++
					return
				}
				const open = { raw: '', overflow: false }
				script = open
				element.onEndTag(
					guarded(() => {
						script = null
						if (open.overflow || scan.jsonLd.length >= caps.jsonLd || !fits(open.raw.length)) {
							scan.dropped.jsonLd++
						} else {
							scan.jsonLd.push(open.raw)
						}
					})
				)
			}),
			text: guarded<Text>((chunk) => {
				scan.work.textChunks++
				const open = script
				if (open === null || open.overflow) {
					return
				}
				if (open.raw.length + chunk.text.length > caps.jsonLdChars) {
					open.overflow = true
					open.raw = ''
				} else {
					open.raw += chunk.text
				}
			}),
		})

	const body = input.subarray(charset.bomLength)
	const native = !TRANSCODED.has(charset.label)
	const bytes = native ? body : new TextEncoder().encode(new TextDecoder(charset.label).decode(body))
	let transformed: Response
	try {
		// An unsupported label fails here, synchronously, before any pumping.
		transformed = rewriter.transform(
			new Response(chunks(bytes, signal), {
				headers: { 'content-type': `text/html; charset=${native ? charset.label : 'utf-8'}` },
			})
		)
	} catch {
		return { failed: 'parser' }
	}
	try {
		await transformed.body?.pipeTo(new WritableStream(), signal === undefined ? {} : { signal })
	} catch (error) {
		signal?.throwIfAborted()
		return failureOf(error)
	}
	signal?.throwIfAborted()
	if (broken) {
		return { failed: 'parser' }
	}
	if (hasFrameset(bytes)) {
		scan.relMeWithFrameset = true
		scan.dropped.relMe += scan.relMe.length
		scan.outputUnits -= scan.relMe.reduce((sum, href) => sum + (href?.length ?? 0), 0)
		scan.relMe = []
	}
	return scan
}
