import { MastodonError } from 'wildebeest/backend/src/errors'
import { output, SafeParseReturnType, SomeZodObject, z, ZodObject, ZodRawShape, ZodTypeAny } from 'zod'

export const HTTPS = 'https://'

export type JsonResponse<T> = Response & {
	_T: T
}

export type MastodonApiResponse<T> = JsonResponse<T> | JsonResponse<MastodonError>

export function makeJsonResponse<T>(
	data: T,
	init: ResponseInit = {
		headers: {
			'content-type': 'application/json; charset=utf-8',
		},
	}
): JsonResponse<T> {
	return new Response(JSON.stringify(data), init) as JsonResponse<T>
}

// The following variable is taken from the zodix library (https://github.com/rileytomasek/zodix)
// Copyright (c) 2022 Riley Tomasek
// The zodix library is released under the MIT License.
const isZodType = (input: ZodRawShape | ZodTypeAny): input is ZodTypeAny => {
	return typeof input.parse === 'function'
}

const isZodObject = (input: ZodTypeAny): input is SomeZodObject => {
	return z.getParsedType(input) === z.ZodParsedType.object
}

const isAllPropsOptional = (input: ZodTypeAny): boolean => {
	if (isZodObject(input)) {
		return Object.values(input.shape).every((v) => v.isOptional())
	}
	return false
}

// The following type is taken from the zodix library (https://github.com/rileytomasek/zodix)
// Copyright (c) 2022 Riley Tomasek
// The zodix library is released under the MIT License.
type ParsedData<T extends ZodRawShape | ZodTypeAny> = T extends ZodTypeAny
	? output<T>
	: T extends ZodRawShape
	? output<ZodObject<T>>
	: never

// The following type is taken from the zodix library (https://github.com/rileytomasek/zodix)
// Copyright (c) 2022 Riley Tomasek
// The zodix library is released under the MIT License.
type SafeParsedData<T extends ZodRawShape | ZodTypeAny> = T extends ZodTypeAny
	? SafeParseReturnType<z.infer<T>, ParsedData<T>>
	: T extends ZodRawShape
	? SafeParseReturnType<ZodObject<T>, ParsedData<T>>
	: never

// The following type is taken from the zodix library (https://github.com/rileytomasek/zodix)
// Copyright (c) 2022 Riley Tomasek
// The zodix library is released under the MIT License.
type ParsedSearchParams = Record<string, string | string[]>

function parseSearchParams(searchParams: URLSearchParams): ParsedSearchParams {
	const values: ParsedSearchParams = {}
	for (const [key, value] of searchParams) {
		if (!key.endsWith('[]')) {
			values[key] = value
			continue
		}

		const currentVal = values[key]
		if (currentVal && Array.isArray(currentVal)) {
			currentVal.push(value)
		} else if (currentVal) {
			values[key] = [currentVal, value]
		} else {
			values[key] = [value]
		}
	}
	for (const key in values) {
		if (key.endsWith('[]')) {
			const newKey = key.slice(0, -2)
			values[newKey] = [...values[key]]
			delete values[key]
		}
	}
	return values
}

export async function readParams<T extends ZodRawShape | ZodTypeAny>(
	request: Request,
	schema: T
): Promise<SafeParsedData<T>> {
	const finalSchema = isZodType(schema) ? schema : z.object(schema)
	const url = new URL(request.url)
	return finalSchema.safeParseAsync(parseSearchParams(url.searchParams)) as Promise<SafeParsedData<T>>
}

// Extract the request body as the type `T`. Use this function when the requset
// can be url encoded, form data or JSON. However, not working for formData
// containing binary data (like File).
export async function readBody<T extends ZodRawShape | ZodTypeAny>(
	request: Request,
	schema: T
): Promise<SafeParsedData<T>> {
	try {
		const finalSchema = isZodType(schema) ? schema : z.object(schema)

		const contentType = request.headers.get('content-type')
		if (contentType === null) {
			if (isAllPropsOptional(finalSchema)) {
				return finalSchema.safeParseAsync({}) as Promise<SafeParsedData<T>>
			}
			throw new Error('invalid request')
		}

		if (contentType.startsWith('application/json')) {
			const url = new URL(request.url)
			const data = await request.json<Record<string, unknown>>()
			return finalSchema.safeParseAsync({
				...parseSearchParams(url.searchParams),
				...data,
			}) as Promise<SafeParsedData<T>>
		}
		const data = ['charset', 'multipart/form-data', 'boundary'].some((v) => contentType.includes(v))
			? await localFormDataParse(request)
			: await request.formData()

		// Context on `as any` usage: https://github.com/microsoft/TypeScript/issues/30584
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = parseSearchParams(new URLSearchParams(data as any))
		return finalSchema.safeParseAsync(result) as Promise<SafeParsedData<T>>
	} catch (err: unknown) {
		if (err instanceof Error) {
			return {
				success: false,
				error: new z.ZodError([
					{
						code: z.ZodIssueCode.custom,
						path: [],
						message: err.message,
					},
				]),
			} as SafeParsedData<T>
		}
		throw err
	}
}

export async function localFormDataParse(request: Request): Promise<FormData> {
	const contentType = request.headers.get('content-type')
	if (contentType === null) {
		throw new Error('invalid request')
	}

	console.log('will attempt local parse of form data')
	const rBody = await request.text()
	const enc = new TextEncoder()
	const bodyArr = enc.encode(rBody)
	const boundary = getBoundary(contentType)
	console.log(`Got boundary ${boundary}`)
	const parts = parse(bodyArr, boundary)
	console.log(`parsed ${parts.length} parts`)
	const dec = new TextDecoder()
	const form: FormData = new FormData()
	for (const part of parts) {
		const value = dec.decode(part.data)
		form.append(part.name || 'null', value)
	}

	return form
}

// temporary code to deal with EW bug
/**
 * Multipart Parser (Finite State Machine)
 * usage:
 * const multipart = require('./multipart.js');
 * const body = multipart.DemoData(); 							   // raw body
 * const body = Buffer.from(event['body-json'].toString(),'base64'); // AWS case
 * const boundary = multipart.getBoundary(event.params.header['content-type']);
 * const parts = multipart.Parse(body,boundary);
 * each part is:
 * { filename: 'A.txt', type: 'text/plain', data: <Buffer 41 41 41 41 42 42 42 42> }
 *  or { name: 'key', data: <Buffer 41 41 41 41 42 42 42 42> }
 */

type Part = {
	contentDispositionHeader: string
	contentTypeHeader: string
	part: number[]
}

type Input = {
	filename?: string
	name?: string
	type: string
	data: Uint8Array
}

enum ParsingState {
	INIT,
	READING_HEADERS,
	READING_DATA,
	READING_PART_SEPARATOR,
}

export function parse(multipartBodyBuffer: Uint8Array, boundary: string): Input[] {
	let lastline = ''
	let contentDispositionHeader = ''
	let contentTypeHeader = ''
	let state: ParsingState = ParsingState.INIT
	let buffer: number[] = []
	const allParts: Input[] = []

	let currentPartHeaders: string[] = []

	for (let i = 0; i < multipartBodyBuffer.length; i++) {
		const oneByte: number = multipartBodyBuffer[i]
		const prevByte: number | null = i > 0 ? multipartBodyBuffer[i - 1] : null
		// 0x0a => \n
		// 0x0d => \r
		const newLineDetected: boolean = oneByte === 0x0a && prevByte === 0x0d
		const newLineChar: boolean = oneByte === 0x0a || oneByte === 0x0d

		if (!newLineChar) lastline += String.fromCharCode(oneByte)
		if (ParsingState.INIT === state && newLineDetected) {
			// searching for boundary
			if ('--' + boundary === lastline) {
				state = ParsingState.READING_HEADERS // found boundary. start reading headers
			}
			lastline = ''
		} else if (ParsingState.READING_HEADERS === state && newLineDetected) {
			// parsing headers. Headers are separated by an empty line from the content. Stop reading headers when the line is empty
			if (lastline.length) {
				currentPartHeaders.push(lastline)
			} else {
				// found empty line. search for the headers we want and set the values
				for (const h of currentPartHeaders) {
					if (h.toLowerCase().startsWith('content-disposition:')) {
						contentDispositionHeader = h
					} else if (h.toLowerCase().startsWith('content-type:')) {
						contentTypeHeader = h
					}
				}
				state = ParsingState.READING_DATA
				buffer = []
			}
			lastline = ''
		} else if (ParsingState.READING_DATA === state) {
			// parsing data
			if (lastline.length > boundary.length + 4) {
				lastline = '' // mem save
			}
			if ('--' + boundary === lastline) {
				const j = buffer.length - lastline.length
				const part = buffer.slice(0, j - 1)

				allParts.push(process({ contentDispositionHeader, contentTypeHeader, part }))
				buffer = []
				currentPartHeaders = []
				lastline = ''
				state = ParsingState.READING_PART_SEPARATOR
				contentDispositionHeader = ''
				contentTypeHeader = ''
			} else {
				buffer.push(oneByte)
			}
			if (newLineDetected) {
				lastline = ''
			}
		} else if (ParsingState.READING_PART_SEPARATOR === state) {
			if (newLineDetected) {
				state = ParsingState.READING_HEADERS
			}
		}
	}
	return allParts
}

//  read the boundary from the content-type header sent by the http client
//  this value may be similar to:
//  'multipart/form-data; boundary=----WebKitFormBoundaryvm5A9tzU1ONaGP5B',
export function getBoundary(header: string): string {
	const items = header.split(';')
	if (items) {
		for (let i = 0; i < items.length; i++) {
			const item = new String(items[i]).trim()
			if (item.indexOf('boundary') >= 0) {
				const k = item.split('=')
				return new String(k[1]).trim().replace(/^["']|["']$/g, '')
			}
		}
	}
	return ''
}

function process(part: Part): Input {
	// will transform this object:
	// { header: 'Content-Disposition: form-data; name="uploads[]"; filename="A.txt"',
	// info: 'Content-Type: text/plain',
	// part: 'AAAABBBB' }
	// into this one:
	// { filename: 'A.txt', type: 'text/plain', data: <Buffer 41 41 41 41 42 42 42 42> }
	const obj = function (str: string) {
		const k = str.split('=')
		const a = k[0].trim()

		const b = JSON.parse(k[1].trim())
		const o = {}
		Object.defineProperty(o, a, {
			value: b,
			writable: true,
			enumerable: true,
			configurable: true,
		})
		return o
	}
	const header = part.contentDispositionHeader.split(';')

	const filenameData = header[2]
	let input = {}
	if (filenameData) {
		input = obj(filenameData)
		const contentType = part.contentTypeHeader.split(':')[1].trim()
		Object.defineProperty(input, 'type', {
			value: contentType,
			writable: true,
			enumerable: true,
			configurable: true,
		})
	}
	// always process the name field
	Object.defineProperty(input, 'name', {
		value: header[1].split('=')[1].replace(/"/g, ''),
		writable: true,
		enumerable: true,
		configurable: true,
	})

	Object.defineProperty(input, 'data', {
		value: Uint8Array.from(part.part),
		writable: true,
		enumerable: true,
		configurable: true,
	})
	return input as Input
}
