// Web pages served from Node with exact bytes, for the compressed-body tests of test/web-page-encoding.test.ts (the
// WEB_PAGE_FIXTURES binding of vitest.config.ts). A raw Node handler writes the compressed bytes as given: Miniflare
// compresses what an ordinary function binding returns, which would double-encode a corrupt fixture. Responses reach
// the suite through workerd's fetch path, so workerd's own Content-Encoding decoding applies to them.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { brotliCompressSync, constants, createGzip, deflateSync, gzipSync } from 'node:zlib'

const PAGE = Buffer.from('<title>compressed</title><a rel="me" href="https://actor.example/u/a">')
// 16 MiB of zeros after the page, as a gzip bomb: about 16 KiB on the wire.
const BOMB = gzipSync(Buffer.concat([PAGE, Buffer.alloc(16 * 1024 * 1024)]), { level: 9 })
// A zstd frame of '<title>zstd</title>' (made once with zstd; Node 22 before 22.15 has no zstd encoder).
const ZSTD = Buffer.from('28b52ffd20139900003c7469746c653e7a7374643c2f7469746c653e', 'hex')
// A gzip header followed by bytes that are not a deflate stream.
const CORRUPT_GZIP = Buffer.concat([gzipSync(PAGE).subarray(0, 10), Buffer.from('not a deflate stream at all')])
const CORRUPT_BR = Buffer.from('not a brotli stream, though it says so')
// An oEmbed document, for the sink's JSON mode.
const JSON_DOCUMENT = Buffer.from('{"version":"1.0","type":"link","title":"compressed"}')

// The stalled responses whose connection the client has closed, by id.
const closed = new Set<string>()

function send(res: ServerResponse, encoding: string | null, body: Buffer): void {
	const headers: Record<string, string> = { 'content-type': 'text/html' }
	if (encoding !== null) {
		headers['content-encoding'] = encoding
	}
	res.writeHead(200, headers)
	res.end(body)
}

export function webPageFixtures(req: IncomingMessage, res: ServerResponse): void {
	const url = new URL(req.url ?? '/', 'http://fixtures.invalid')
	const encoding = url.searchParams.get('encoding')
	switch (url.pathname) {
		case '/gzip':
			return send(res, encoding ?? 'gzip', gzipSync(PAGE))
		case '/br':
			return send(res, 'br', brotliCompressSync(PAGE))
		case '/json-gzip':
			return send(res, 'gzip', gzipSync(JSON_DOCUMENT))
		case '/json-br':
			return send(res, 'br', brotliCompressSync(JSON_DOCUMENT))
		case '/deflate':
			return send(res, 'deflate', deflateSync(PAGE))
		case '/zstd':
			return send(res, 'zstd', ZSTD)
		case '/gzip-gzip':
			return send(res, encoding ?? 'gzip, gzip', gzipSync(gzipSync(PAGE)))
		case '/bomb':
			return send(res, 'gzip', BOMB)
		case '/corrupt-gzip':
			return send(res, 'gzip', CORRUPT_GZIP)
		case '/corrupt-br':
			return send(res, 'br', CORRUPT_BR)
		case '/stall': {
			// The page and `zeros` zero bytes (4 MiB by default) compressed and flushed without end: the body never
			// finishes, so only a client that cancels it closes the connection.
			const id = url.searchParams.get('id') ?? ''
			res.on('close', () => closed.add(id))
			res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' })
			const gzip = createGzip({ flush: constants.Z_SYNC_FLUSH })
			gzip.pipe(res)
			gzip.write(PAGE)
			gzip.write(Buffer.alloc(Number(url.searchParams.get('zeros') ?? 4 * 1024 * 1024)))
			return
		}
		case '/closed':
			res.writeHead(200, { 'content-type': 'application/json' })
			res.end(JSON.stringify(closed.has(url.searchParams.get('id') ?? '')))
			return
		default:
			res.writeHead(404)
			res.end()
	}
}
