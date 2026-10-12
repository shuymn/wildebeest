// An in-memory S3 for the backup tests: path-style requests to https://s3.test/<bucket>/<key>, the calls the backup
// makes (multipart uploads, put, get, delete, ListObjectsV2, ListMultipartUploads), S3's part rule (every part but
// the last at least 5 MiB), and a check that each request is SigV4-signed by the configured key id and carries the
// SHA-256 of its body. `fail` injects an error status for a request.

export type S3Op =
	| 'create-upload'
	| 'upload-part'
	| 'complete-upload'
	| 'abort-upload'
	| 'put'
	| 'get'
	| 'delete'
	| 'list'
	| 'list-uploads'

export type S3Request = { op: S3Op; key: string | null; status: number }

const MIB = 1024 * 1024

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
		b.toString(16).padStart(2, '0')
	).join('')
}

function escape(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export class S3Mock {
	readonly objects = new Map<string, Uint8Array>()
	readonly uploads = new Map<string, { key: string; parts: Map<number, { body: Uint8Array; etag: string }> }>()
	readonly requests: S3Request[] = []
	// Every body the bucket received (parts and objects), to check that none is plaintext.
	readonly received: Uint8Array[] = []
	fail: ((op: S3Op, key: string | null) => number | undefined) | undefined
	// Keys a listing leaves out, as an eventually consistent store might.
	hidden = new Set<string>()
	#next = 1

	constructor(
		readonly bucket = 'kopje-backups',
		readonly accessKeyId = 'AKIDKOPJETEST',
		readonly minPartBytes = 5 * MIB,
		readonly maxListKeys = 1000
	) {}

	readonly fetch = async (request: Request): Promise<Response> => {
		const url = new URL(request.url)
		const segments = url.pathname.split('/').slice(1).map(decodeURIComponent)
		if (url.origin !== 'https://s3.test' || segments[0] !== this.bucket) {
			return new Response('<Error><Code>NoSuchBucket</Code></Error>', { status: 404 })
		}
		const key = segments.length > 1 ? segments.slice(1).join('/') : null
		const q = url.searchParams
		const op: S3Op =
			key === null
				? q.has('uploads')
					? 'list-uploads'
					: 'list'
				: request.method === 'POST'
					? q.has('uploads')
						? 'create-upload'
						: 'complete-upload'
					: request.method === 'PUT'
						? q.has('uploadId')
							? 'upload-part'
							: 'put'
						: request.method === 'DELETE'
							? q.has('uploadId')
								? 'abort-upload'
								: 'delete'
							: 'get'
		const response = await this.#handle(op, key, q, request)
		this.requests.push({ op, key, status: response.status })
		return response
	}

	async #handle(op: S3Op, key: string | null, q: URLSearchParams, request: Request): Promise<Response> {
		const auth = request.headers.get('authorization') ?? ''
		if (!auth.startsWith(`AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/`)) {
			return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 })
		}
		const body = new Uint8Array(await request.arrayBuffer())
		if (request.headers.get('x-amz-content-sha256') !== (await sha256Hex(body))) {
			return new Response('<Error><Code>XAmzContentSHA256Mismatch</Code></Error>', { status: 400 })
		}
		const injected = this.fail?.(op, key)
		if (injected !== undefined) {
			return new Response('<Error><Code>Injected</Code></Error>', { status: injected })
		}
		switch (op) {
			case 'create-upload': {
				const uploadId = `upload-${this.#next++}`
				this.uploads.set(uploadId, { key: key!, parts: new Map() })
				return xml(`<InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`)
			}
			case 'upload-part': {
				const upload = this.uploads.get(q.get('uploadId') ?? '')
				if (upload === undefined || upload.key !== key) {
					return new Response('<Error><Code>NoSuchUpload</Code></Error>', { status: 404 })
				}
				const etag = `"etag-${this.#next++}"`
				this.received.push(body)
				upload.parts.set(Number(q.get('partNumber')), { body, etag })
				return new Response(null, { headers: { etag } })
			}
			case 'complete-upload': {
				const uploadId = q.get('uploadId') ?? ''
				const upload = this.uploads.get(uploadId)
				if (upload === undefined || upload.key !== key) {
					return new Response('<Error><Code>NoSuchUpload</Code></Error>', { status: 404 })
				}
				const listed = [
					...new TextDecoder().decode(body).matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>([^<]*)<\/ETag>/g),
				]
				const parts = listed.map(([, n, etag]) => ({ n: Number(n), etag: (etag ?? '').replace(/&quot;/g, '"') }))
				const chosen = parts.map((p) => upload.parts.get(p.n))
				if (
					parts.length === 0 ||
					parts.some((p, i) => p.n !== i + 1 || chosen[i]?.etag !== p.etag) ||
					chosen.slice(0, -1).some((p) => (p?.body.byteLength ?? 0) < this.minPartBytes)
				) {
					return new Response('<Error><Code>InvalidPart</Code></Error>', { status: 400 })
				}
				const total = chosen.reduce((n, p) => n + (p?.body.byteLength ?? 0), 0)
				const joined = new Uint8Array(total)
				let offset = 0
				for (const p of chosen) {
					joined.set(p!.body, offset)
					offset += p!.body.byteLength
				}
				this.objects.set(key!, joined)
				this.uploads.delete(uploadId)
				return xml('<CompleteMultipartUploadResult></CompleteMultipartUploadResult>')
			}
			case 'abort-upload': {
				const uploadId = q.get('uploadId') ?? ''
				if (this.uploads.get(uploadId)?.key !== key) {
					return new Response('<Error><Code>NoSuchUpload</Code></Error>', { status: 404 })
				}
				this.uploads.delete(uploadId)
				return new Response(null, { status: 204 })
			}
			case 'put':
				this.received.push(body)
				this.objects.set(key!, body)
				return new Response(null, { status: 200, headers: { etag: `"etag-${this.#next++}"` } })
			case 'get': {
				const object = this.objects.get(key!)
				return object === undefined
					? new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 })
					: new Response(object)
			}
			case 'delete':
				this.objects.delete(key!)
				return new Response(null, { status: 204 })
			case 'list': {
				const prefix = q.get('prefix') ?? ''
				const after = q.get('continuation-token') ?? ''
				const keys = [...this.objects.keys()]
					.filter((k) => k.startsWith(prefix) && k > after && !this.hidden.has(k))
					.sort()
				const page = keys.slice(0, this.maxListKeys)
				const truncated = keys.length > page.length
				return xml(
					'<ListBucketResult>' +
						page
							.map((k) => `<Contents><Key>${escape(k)}</Key><Size>${this.objects.get(k)!.byteLength}</Size></Contents>`)
							.join('') +
						`<IsTruncated>${truncated}</IsTruncated>` +
						(truncated ? `<NextContinuationToken>${escape(page.at(-1)!)}</NextContinuationToken>` : '') +
						'</ListBucketResult>'
				)
			}
			case 'list-uploads': {
				const prefix = q.get('prefix') ?? ''
				return xml(
					'<ListMultipartUploadsResult>' +
						[...this.uploads]
							.filter(([, u]) => u.key.startsWith(prefix))
							.map(([id, u]) => `<Upload><Key>${escape(u.key)}</Key><UploadId>${id}</UploadId></Upload>`)
							.join('') +
						'<IsTruncated>false</IsTruncated></ListMultipartUploadsResult>'
				)
			}
		}
	}

	// Starts a multipart upload directly, as an earlier invocation that died would have left it.
	strayUpload(key: string, part?: Uint8Array): string {
		const uploadId = `upload-${this.#next++}`
		const parts = new Map<number, { body: Uint8Array; etag: string }>()
		if (part !== undefined) {
			parts.set(1, { body: part, etag: '"stray"' })
		}
		this.uploads.set(uploadId, { key, parts })
		return uploadId
	}

	count(op: S3Op): number {
		return this.requests.filter((r) => r.op === op).length
	}
}

function xml(text: string): Response {
	return new Response(`<?xml version="1.0" encoding="UTF-8"?>${text}`, {
		headers: { 'content-type': 'application/xml' },
	})
}
