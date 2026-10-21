import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { guardFixtures, parse, sources, type Source } from './source-scan.js'

// Every /assets/<name> a source names in a string or template literal is a file of public/assets, which Workers static
// assets serves without running the Worker (wrangler.jsonc run_worker_first). A path with no file is a broken image or
// script in every client that follows it.

const ASSETS = new URL('../public/assets/', import.meta.url)
const NAMED = /\/assets\/([A-Za-z0-9._-]+)/g

function missingAssets(files: readonly Source[]): string[] {
	const found: string[] = []
	for (const source of files) {
		for (const literal of parse(source).literals) {
			for (const part of literal.parts) {
				if (!('text' in part)) {
					continue
				}
				for (const [, name] of part.text.matchAll(NAMED)) {
					if (!existsSync(new URL(name!, ASSETS))) {
						found.push(`${source.path}: /assets/${name!}`)
					}
				}
			}
		}
	}
	return found
}

// The width and height of a PNG, read from its IHDR chunk (the first, at byte 8).
function pngSize(bytes: Buffer): { width: number; height: number } {
	expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
	expect(bytes.subarray(12, 16).toString('latin1')).toBe('IHDR')
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

describe('static assets', () => {
	const SOURCES = sources('src')

	it('sees the sources that name assets', () => {
		expect(SOURCES.map((s) => s.path)).toContain('src/mastodon/instance.ts')
	})

	it('names only assets public/assets holds', () => {
		expect(missingAssets(SOURCES)).toEqual([])
	})

	it('ships the instance thumbnail as a 1200x630 PNG', () => {
		expect(pngSize(readFileSync(new URL('thumbnail.png', ASSETS)))).toEqual({ width: 1200, height: 630 })
	})

	describe('the finder', () => {
		guardFixtures(missingAssets, {
			flagged: {
				'a constant': ["const THUMBNAIL = '/assets/missing.png'", 'src/domain/probe.ts: /assets/missing.png'],
				'a template': [
					'export const url = (o: string) => `${o}/assets/gone.js`',
					'src/domain/probe.ts: /assets/gone.js',
				],
			},
			passed: {
				'a shipped asset': "const HEADER = '/assets/header.png'",
				'a template of a shipped asset': 'export const url = (o: string) => `${o}/assets/thumbnail.png`',
				'a comment': '// /assets/missing.png\nexport const x = 1',
				'a pattern': "const SKIP = '!/assets/*'",
			},
		})
	})
})
