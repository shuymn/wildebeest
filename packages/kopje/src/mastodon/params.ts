import { readBoundedBody } from '../platform/body'

// Request parameters as Mastodon reads them: the query string merged with a JSON, urlencoded or multipart body
// (clients send all three). JSON is flattened to form names, so `{"source":{"privacy":"public"}}` reads as
// `source[privacy]` and `{"ids":["1","2"]}` as `ids[]`, the same as the form encodings.

export const API_BODY_LIMIT = 1024 * 1024

export class Params {
	constructor(private readonly entries: readonly (readonly [string, string])[]) {}

	// The body's value wins over the query's.
	get(name: string): string | undefined {
		return this.entries.find(([key]) => key === name)?.[1]
	}

	// Whether `name` or `name[]` was sent at all, even with no value: an explicitly empty list is not an absent one.
	has(name: string): boolean {
		return this.entries.some(([key]) => key === name || key === `${name}[]`)
	}

	// The first of `names` sent more than once (query and body together), for parameters that must be single
	// (RFC 6749 §3.1, §3.2). Array parameters (`name[]`) are not scalars and are never named here.
	repeated(names: readonly string[]): string | undefined {
		return names.find((name) => this.entries.filter(([key]) => key === name).length > 1)
	}

	// Values of `name[]` and of a repeated `name`.
	getAll(name: string): string[] {
		return this.entries.filter(([key]) => key === name || key === `${name}[]`).map(([, value]) => value)
	}
}

export type ParamsResult = { ok: true; params: Params } | { ok: false; status: 400 | 413 }

export async function readParams(request: Request, limit = API_BODY_LIMIT): Promise<ParamsResult> {
	const query = [...new URL(request.url).searchParams.entries()]
	if (request.method === 'GET' || request.method === 'HEAD') {
		return { ok: true, params: new Params(query) }
	}
	const body = await readBoundedBody(request, limit)
	if (body === 'too-large') {
		return { ok: false, status: 413 }
	}
	const contentType = request.headers.get('content-type') ?? ''
	try {
		const entries = body.byteLength === 0 ? [] : await bodyEntries(contentType, body)
		return { ok: true, params: new Params([...entries, ...query]) }
	} catch {
		return { ok: false, status: 400 }
	}
}

async function bodyEntries(contentType: string, body: Uint8Array): Promise<[string, string][]> {
	const type = contentType.split(';')[0]?.trim().toLowerCase()
	if (type === 'application/json') {
		const entries: [string, string][] = []
		flatten('', JSON.parse(new TextDecoder().decode(body)), entries)
		return entries
	}
	if (type === 'application/x-www-form-urlencoded' || type === 'multipart/form-data') {
		const form = await new Response(body, { headers: { 'content-type': contentType } }).formData()
		// Files are not read here; media uploads have their own endpoints.
		return [...form.entries()].filter((entry): entry is [string, string] => typeof entry[1] === 'string')
	}
	return []
}

function flatten(prefix: string, value: unknown, out: [string, string][]): void {
	if (Array.isArray(value)) {
		// An empty array reads as `name[]=` with no value, as a form sends an empty list.
		if (value.length === 0 && prefix !== '') {
			out.push([`${prefix}[]`, ''])
		}
		value.forEach((item, index) => {
			const scalar = item === null || typeof item !== 'object'
			flatten(scalar ? `${prefix}[]` : `${prefix}[${index}]`, item, out)
		})
	} else if (typeof value === 'object' && value !== null) {
		for (const [key, item] of Object.entries(value)) {
			flatten(prefix === '' ? key : `${prefix}[${key}]`, item, out)
		}
	} else if (prefix !== '') {
		// Scalars only here: strings as they are, numbers and booleans as JSON writes them, null as blank.
		out.push([prefix, typeof value === 'string' ? value : value === null ? '' : JSON.stringify(value)])
	}
}

// Rails' boolean casting: blank is absent, "0", "f", "false" and "off" are false, anything else is true.
export function parseBoolean(value: string | undefined): boolean | undefined {
	if (value === undefined || value === '') {
		return undefined
	}
	return !['0', 'f', 'false', 'off'].includes(value.toLowerCase())
}
