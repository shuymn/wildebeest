import { readBoundedBody } from '../platform/body'
import { utf8Length } from '../platform/dump-format'

// Request parameters as Mastodon reads them: the query string merged with a JSON, urlencoded or multipart body
// (clients send all three). JSON is flattened to form names, so `{"source":{"privacy":"public"}}` reads as
// `source[privacy]` and `{"ids":["1","2"]}` as `ids[]`, the same as the form encodings.
//
// Bounds (RES-1), all in force before or while parsing:
// - the body: `limit` bytes (API_BODY_LIMIT by default); a multipart body on a route with a file rule may also carry
//   each declared file, so it may be `limit + names.length * (maxBytes + FILE_PART_SLACK)` bytes;
// - a form body's text: the UTF-8 bytes of every text entry's name and value and of the query, at most `limit`;
// - JSON paths: at most MAX_PARAM_PATHS generated keys (object members, array objects, empty lists; a list's scalar
//   items are not counted), PARAM_PATH_BUDGET UTF-16 code units of every generated key, charged before each key is
//   built, and MAX_PARAM_DEPTH levels of nesting.

export const API_BODY_LIMIT = 1024 * 1024
// The part headers and boundary of one declared file.
export const FILE_PART_SLACK = 16 * 1024
// Rack's param_depth_limit (ParamsTooDeepError, answered 400).
export const MAX_PARAM_DEPTH = 32
export const MAX_PARAM_PATHS = 10_000
export const PARAM_PATH_BUDGET = 2 * API_BODY_LIMIT

// The file parameters a route reads, and the most bytes one of them may have.
export type FileRule = { names: readonly string[]; maxBytes: number }
export type ReadOptions = { limit?: number; files?: FileRule }

// The tail of an object field key after `name[`: `index][field]` or `][field]`.
const OBJECT_FIELD = /^(\d*)\]\[([^\]]+)\]$/

// A file part of a name the route declares no file rule for, and how many text entries the body had before it.
type FilePart = readonly [name: string, at: number]

// The value objects(name, { files }) reads for a listed field sent as a file part: presence only, never the file.
export const SENT_FILE = '(file)'

// `files`: fields of the objects whose file parts are read, as SENT_FILE, at their place in the body.
export type ObjectOptions = { files?: readonly string[] }

// A file part's value while objects() groups the parts; no text value equals it.
const FILE_VALUE: unique symbol = Symbol('file part')
type Value = string | typeof FILE_VALUE

export class Params {
	constructor(
		readonly entries: readonly (readonly [string, string])[],
		readonly files: ReadonlyMap<string, File> = new Map(),
		// The JSON object prefixes the body sent, empty objects included (sentObject).
		readonly objectPrefixes: ReadonlySet<string> = new Set(),
		// The names a JSON body sent as an empty array (list).
		readonly emptyLists: ReadonlySet<string> = new Set(),
		// Undeclared file parts of a multipart body in body order; `at` indexes the body's prefix of `entries`.
		private readonly fileParts: readonly FilePart[] = []
	) {}

	// These body parameters with the query's merged in: the body wins for a declared name, whose effective value is
	// otherwise the query's last; other query entries follow the body's.
	withQuery(query: readonly (readonly [string, string])[], declared: readonly string[]): Params {
		const names = new Set(declared)
		// The maps are read directly: the parameter conformance check counts accessor calls as the handler's reads.
		const sent = (name: string) => this.files.has(name) || this.entries.some(([key]) => key === name)
		const declaredQuery = [...names].flatMap((name): [string, string][] => {
			const value = sent(name) ? undefined : query.findLast(([key]) => key === name)?.[1]
			return value === undefined ? [] : [[name, value]]
		})
		const entries = [...this.entries, ...query.filter(([key]) => !names.has(key)), ...declaredQuery]
		return new Params(entries, this.files, this.objectPrefixes, this.emptyLists, this.fileParts)
	}

	// The body's value wins over the query's.
	get(name: string): string | undefined {
		return this.entries.find(([key]) => key === name)?.[1]
	}

	// A declared file parameter whose effective value is a file (readParams' typed selection): then get(name) is
	// undefined, and the other way round.
	file(name: string): File | undefined {
		return this.files.get(name)
	}

	// Whether `name` or `name[]` was sent at all, even with no value: an explicitly empty list is not an absent one.
	has(name: string): boolean {
		return this.entries.some(([key]) => key === name || key === `${name}[]`)
	}

	// Whether `name` was sent as an object: some `name[field]`, as JSON `{"name":{"field":...}}` reads. An empty object
	// sends nothing, and an array (`name[]`) is not an object.
	hasObject(name: string): boolean {
		return this.entries.some(([key]) => key.startsWith(`${name}[`) && !key.startsWith(`${name}[]`))
	}

	// hasObject, and also a JSON object with no scalar inside (`{"home":{}}`, `{"fields_attributes":{"0":{}}}`), which
	// Rails reads as a sent, empty hash.
	sentObject(name: string): boolean {
		return this.objectPrefixes.has(name) || this.hasObject(name)
	}

	// The first of `names` sent more than once (query and body together), for parameters that must be single
	// (RFC 6749 §3.1, §3.2). Array parameters (`name[]`) are not scalars and are never named here.
	repeated(names: readonly string[]): string | undefined {
		return names.find((name) => this.entries.filter(([key]) => key === name).length > 1)
	}

	// The objects of an array parameter: JSON sends `name[0][field]` (indexed), forms send `name[][field]`, where a field
	// that repeats starts the next object (as Rack reads it). Without `files`, file parts are not read. With it, every
	// file part is grouped at its place in the body, as Rack groups it, and then read as SENT_FILE in a field of
	// `files` and as absent in any other.
	objects(name: string, options: ObjectOptions = {}): Record<string, string>[] {
		const prefix = `${name}[`
		const files = options.files === undefined ? null : new Set(options.files)
		const indexed = new Map<string, Record<string, Value>>()
		const sequential: Record<string, Value>[] = []
		const add = (key: string, value: Value) => {
			// The name is compared as a string; only the `[index][field]` tail is a pattern.
			const match = key.startsWith(prefix) ? OBJECT_FIELD.exec(key.slice(prefix.length)) : null
			if (match === null) {
				return
			}
			const [, index = '', field = ''] = match
			if (index !== '') {
				const object = indexed.get(index) ?? {}
				object[field] = value
				indexed.set(index, object)
				return
			}
			const last = sequential.at(-1)
			if (last === undefined || field in last) {
				sequential.push({ [field]: value })
			} else {
				last[field] = value
			}
		}
		const parts = files === null ? [] : this.fileParts
		let next = 0
		const partsBefore = (at: number) => {
			for (let part = parts[next]; part !== undefined && part[1] <= at; part = parts[++next]) {
				add(part[0], FILE_VALUE)
			}
		}
		this.entries.forEach(([key, value], at) => {
			partsBefore(at)
			add(key, value)
		})
		partsBefore(Infinity)
		const project = (object: Record<string, Value>): Record<string, string> =>
			Object.fromEntries(
				Object.entries(object).flatMap(([field, value]): [string, string][] =>
					value !== FILE_VALUE ? [[field, value]] : files?.has(field) === true ? [[field, SENT_FILE]] : []
				)
			)
		return [...[...indexed].sort(([a], [b]) => Number(a) - Number(b)).map(([, object]) => object), ...sequential].map(
			project
		)
	}

	// Values of `name[]` only, or undefined when none was sent: an array parameter as Rails' strong parameters permit
	// it (`name: []`), which drop a scalar `name`. A form's `name[]=` is one blank value, as Rack reads it; a JSON
	// empty array is an empty list (its blank entry, which has() and getAll() read, is not a value).
	list(name: string): string[] | undefined {
		const values = this.entries.filter(([key]) => key === `${name}[]`).map(([, value]) => value)
		if (this.emptyLists.has(name)) {
			values.splice(values.indexOf(''), 1)
			return values
		}
		return values.length === 0 ? undefined : values
	}

	// Values of `name[]` and of a repeated `name`.
	getAll(name: string): string[] {
		return this.entries.filter(([key]) => key === name || key === `${name}[]`).map(([, value]) => value)
	}
}

export type ParamsResult = { ok: true; params: Params } | { ok: false; status: 400 | 413 }

// A refusal while parsing: past a size bound (413) or nested too deep (400).
export class ParamsRefused extends Error {
	constructor(readonly status: 400 | 413) {
		super(status === 413 ? 'parameters past their bound' : 'parameters nested too deep')
	}
}

export function mediaTypeOf(contentType: string | undefined): string | undefined {
	return contentType?.split(';')[0]?.trim().toLowerCase()
}

// The body limit of a request: a file route's multipart body may carry its files besides the text. The rule is
// chosen from Content-Type before any byte is read.
export function bodyLimit(contentType: string, options: ReadOptions = {}): number {
	const limit = options.limit ?? API_BODY_LIMIT
	const files = options.files
	return files !== undefined && mediaTypeOf(contentType) === 'multipart/form-data'
		? limit + files.names.length * (files.maxBytes + FILE_PART_SLACK)
		: limit
}

export async function readParams(request: Request, options: ReadOptions = {}): Promise<ParamsResult> {
	const query = [...new URL(request.url).searchParams.entries()]
	if (request.method === 'GET' || request.method === 'HEAD') {
		return { ok: true, params: new Params(query) }
	}
	const contentType = request.headers.get('content-type') ?? ''
	const body = await readBoundedBody(request, bodyLimit(contentType, options))
	if (body === 'too-large') {
		return { ok: false, status: 413 }
	}
	const limit = options.limit ?? API_BODY_LIMIT
	let parsed: Params
	let formText: number | null
	try {
		;({ params: parsed, formText } = await parseCounted(contentType, body, options.files))
	} catch (error) {
		return { ok: false, status: error instanceof ParamsRefused ? error.status : 400 }
	}
	const params = parsed.withQuery(query, options.files?.names ?? [])
	// A JSON body's names are generated, bounded by the path budget, and its values by the body; a form body's text,
	// every text part as sent (before the last-part selection) and the query, is bounded here, so the files a
	// multipart body may carry cannot make room for more text.
	if (formText !== null) {
		let text = formText
		for (const [key, value] of query) {
			text += utf8Length(key) + utf8Length(value)
		}
		if (text > limit) {
			return { ok: false, status: 413 }
		}
	}
	return { ok: true, params }
}

// The parameters of a body (without the query). For each name of `files`, one effective value is chosen as Rails
// reads repeated parts: in body order, each part of that name, text or file, replaces the one before (the last wins).
// That value is either a text entry or a file, never both. Of every other file part only its name and place are kept
// (objects with `files`), never its bytes. A part with an empty filename is text to workerd's parser (Rack drops it
// as an empty file field): empty, it reads as absent where the route reads a blank value so; with bytes, as a text
// value (docs/mastodon-deviations.md).
export async function parseBody(contentType: string, body: Uint8Array, files?: FileRule): Promise<Params> {
	return (await parseCounted(contentType, body, files)).params
}

// parseBody, with the UTF-8 bytes of every text part's name and value of a non-JSON body (null for JSON).
async function parseCounted(
	contentType: string,
	body: Uint8Array,
	files?: FileRule
): Promise<{ params: Params; formText: number | null }> {
	const declared = new Set(files?.names ?? [])
	const type = mediaTypeOf(contentType)
	if (body.byteLength === 0) {
		// An empty body has no text of its own, but the query of a non-JSON request is still counted (readParams).
		return { params: new Params([]), formText: type === 'application/json' ? null : 0 }
	}
	if (type === 'application/json') {
		const entries: [string, string][] = []
		const objects = new Set<string>()
		const empty = new Set<string>()
		// JSON.parse keeps the last of duplicate keys, so repeated() sees form and query duplicates only. RFC 6749 defines
		// form bodies alone, and Doorkeeper (Mastodon) lets the last JSON key win as well.
		flatten(JSON.parse(new TextDecoder().decode(body)), { entries, objects, empty, paths: 0, units: 0 })
		return { params: selectDeclared(entries, new Map(), objects, empty, declared), formText: null }
	}
	if (type === 'application/x-www-form-urlencoded' || type === 'multipart/form-data') {
		const form = await new Response(body, { headers: { 'content-type': contentType } }).formData()
		const entries: [string, string][] = []
		const chosen = new Map<string, string | File>()
		const fileParts: FilePart[] = []
		let formText = 0
		// FormData's entries are typed as strings by the runtime types; a file part is a File.
		for (const [key, value] of form.entries() as Iterable<[string, string | File]>) {
			if (typeof value === 'string') {
				formText += utf8Length(key) + utf8Length(value)
			}
			if (declared.has(key)) {
				chosen.set(key, value)
			} else if (typeof value === 'string') {
				entries.push([key, value])
			} else {
				fileParts.push([key, entries.length])
			}
		}
		const fileValues = new Map<string, File>()
		for (const [key, value] of chosen) {
			if (typeof value === 'string') {
				entries.push([key, value])
			} else {
				fileValues.set(key, value)
			}
		}
		return { params: new Params(entries, fileValues, new Set(), new Set(), fileParts), formText }
	}
	return { params: new Params([]), formText: null }
}

// JSON and form text for a declared name keeps only its last value, so get(name) reads what Rails would assign.
function selectDeclared(
	entries: [string, string][],
	files: Map<string, File>,
	objects: Set<string>,
	empty: Set<string>,
	declared: ReadonlySet<string>
): Params {
	if (declared.size === 0) {
		return new Params(entries, files, objects, empty)
	}
	const last = new Map<string, string>()
	for (const [key, value] of entries) {
		if (declared.has(key)) {
			last.set(key, value)
		}
	}
	return new Params([...entries.filter(([key]) => !declared.has(key)), ...last], files, objects, empty)
}

type Flattening = {
	entries: [string, string][]
	objects: Set<string>
	empty: Set<string>
	paths: number
	units: number
}

// Charges one generated key before its string is built: past MAX_PARAM_PATHS object keys, array objects and empty
// lists, or PARAM_PATH_BUDGET code units of every generated key, the body is refused (413).
function charge(state: Flattening, prefix: string, key: string, path = true): void {
	state.paths += path ? 1 : 0
	state.units += prefix.length + key.length + 2
	if (state.paths > MAX_PARAM_PATHS || state.units > PARAM_PATH_BUDGET) {
		throw new ParamsRefused(413)
	}
}

function flatten(value: unknown, state: Flattening, prefix = '', depth = 0): void {
	if (depth > MAX_PARAM_DEPTH) {
		throw new ParamsRefused(400)
	}
	if (Array.isArray(value)) {
		// An empty array reads as `name[]=` with no value, as a form sends an empty list, and is marked as one (list).
		if (value.length === 0 && prefix !== '') {
			charge(state, prefix, '')
			state.entries.push([`${prefix}[]`, ''])
			state.empty.add(prefix)
		}
		value.forEach((item, index) => {
			const scalar = item === null || typeof item !== 'object'
			const key = scalar ? '' : String(index)
			// A scalar item is charged its code units only: it costs at least two body bytes of its own, and a list of
			// many values (Mastodon reads one of any length) is not a key amplification.
			charge(state, prefix, key, !scalar)
			flatten(item, state, `${prefix}[${key}]`, depth + 1)
		})
	} else if (typeof value === 'object' && value !== null) {
		if (prefix !== '') {
			state.objects.add(prefix)
		}
		for (const [key, item] of Object.entries(value)) {
			charge(state, prefix, key)
			flatten(item, state, prefix === '' ? key : `${prefix}[${key}]`, depth + 1)
		}
	} else if (prefix !== '') {
		// Scalars only here: strings as they are, numbers and booleans as JSON writes them, null as blank.
		state.entries.push([prefix, typeof value === 'string' ? value : value === null ? '' : JSON.stringify(value)])
	}
}

// `offset` as Mastodon's offset endpoints read it (params[:offset].to_i): a negative or unreadable one is 0.
export function offsetParam(p: Params): number {
	return Math.max(Number.parseInt(p.get('offset') ?? '0', 10) || 0, 0)
}

// `limit` as Api::BaseController#limit_param reads it: `fallback` when absent, else the absolute value, at most `max`
// (an unreadable one is 0).
export function limitParam(p: Params, fallback: number, max: number): number {
	const limit = p.get('limit')
	return limit === undefined ? fallback : Math.min(Math.abs(Number.parseInt(limit, 10) || 0), max)
}

// Rails' boolean casting: blank is absent, "0", "f", "false" and "off" are false, anything else is true.
export function parseBoolean(value: string | undefined): boolean | undefined {
	if (value === undefined || value === '') {
		return undefined
	}
	return !['0', 'f', 'false', 'off'].includes(value.toLowerCase())
}
