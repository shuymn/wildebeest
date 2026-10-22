import { expect, it } from 'vitest'

import { type PageScan, SCAN_LIMITS, scanHtml } from '../../src/platform/html-scan'

// The web-page scan benchmark (src/platform/html-scan.ts, NET-3): workerd's HTMLRewriter over 1 MiB pages, a realistic
// one and hostile ones, each scanned RUNS times; the median wall time is printed with what the scan collected, and each
// run asserts that it scanned the whole page and collected what the page holds, so a figure cannot come from a scan
// that stopped early or failed. Local wall time stands in for CPU time; it varies with the machine's load.
//
//   pnpm --filter kopje exec vitest run -c vitest.bench.config.ts test/bench/web-page-scan.bench.ts --silent=false

const MiB = 1024 * 1024
const RUNS = 5
const UTF8 = { label: 'utf-8', bomLength: 0 }

function fill(unit: string, prefix = '', suffix = ''): string {
	return prefix + unit.repeat(Math.floor((MiB - prefix.length - suffix.length) / unit.length)) + suffix
}

// A blog page: a head with the card metadata, a header with rel=me links, then articles of paragraphs, links and
// inline SVG icons up to 1 MiB.
function realistic(): string {
	const metas = Array.from({ length: 20 }, (_, i) => `<meta property="og:p${i}" content="Value &amp; ${i}">`).join('')
	const head =
		'<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>A blog &mdash; posts</title>' +
		`${metas}<link rel="canonical" href="https://blog.example/"><link rel="icon" href="/favicon.ico">` +
		'<script type="application/ld+json">{"@type":"Blog","name":"A blog"}</script></head><body><header>' +
		'<a rel="me" href="https://social.example/@a">Fediverse</a><link rel="me" href="https://other.example/@a">' +
		'</header>'
	const article =
		'<article><h2><a href="/p/1">A post title</a></h2><p>Some text with <em>emphasis</em>, a ' +
		'<a href="https://elsewhere.example/x?a=1&amp;b=2" rel="nofollow">link</a> and an icon ' +
		'<svg viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg>.</p><p>More text &hellip; ' +
		'<code>&lt;tag&gt;</code></p></article>'
	return fill(article, head, '</body></html>')
}

type Case = { page: string; check: (scan: PageScan) => void }

const CASES: Record<string, Case> = {
	realistic: {
		page: realistic(),
		check: (scan) => {
			expect(scan.title).toBe('A blog — posts')
			expect(scan.lang).toBe('en')
			expect(scan.relMe).toEqual(['https://social.example/@a', 'https://other.example/@a'])
			expect(scan.metas).toHaveLength(20)
			expect(scan.links.map((link) => link.rel[0])).toEqual(['canonical', 'icon', 'me'])
			expect(scan.jsonLd).toHaveLength(1)
			expect(scan.relMeAfterForeign).toBe(false)
		},
	},
	'70k closed rel=me anchors': {
		page: fill('<a rel=me href=x></a>'),
		check: (scan) => {
			expect(scan.relMe).toHaveLength(SCAN_LIMITS.relMe)
			expect(scan.dropped.relMe).toBe(Math.floor(MiB / 21) - SCAN_LIMITS.relMe)
		},
	},
	'many titles': {
		page: fill('<title>t</title>'),
		check: (scan) => {
			expect(scan.title).toBe('t')
			expect(scan.work.elements).toBe(Math.floor(MiB / 16))
		},
	},
	'a reference flood in the title': {
		page: fill('&amp;', '<title>', '</title>'),
		check: (scan) => {
			expect(scan.title).toBeNull()
			expect(scan.dropped.values).toBe(1)
		},
	},
	'10k attributes on one tag': {
		page: fill(' a=b', '<a rel=me href=x', '>'),
		check: (scan) => expect(scan.relMe).toEqual(['x']),
	},
	'80k metas': {
		page: fill('<meta name=a>'),
		check: (scan) => {
			expect(scan.metas).toHaveLength(SCAN_LIMITS.metas)
			expect(scan.dropped.metas).toBe(Math.floor(MiB / 13) - SCAN_LIMITS.metas)
		},
	},
}

it('scans 1 MiB pages and reports the median time of each', { timeout: 600_000 }, async () => {
	const report: Record<string, { bytes: number; medianMs: number; elements: number; textChunks: number }> = {}
	for (const [name, { page, check }] of Object.entries(CASES)) {
		const bytes = new TextEncoder().encode(page)
		// Within one repeated unit of 1 MiB.
		expect(bytes.byteLength).toBeGreaterThan(MiB - 1024)
		expect(bytes.byteLength).toBeLessThanOrEqual(MiB)
		const times: number[] = []
		let last: PageScan | undefined
		for (let run = 0; run < RUNS; run++) {
			const started = performance.now()
			const result = await scanHtml(bytes, UTF8)
			times.push(performance.now() - started)
			if ('failed' in result) {
				throw new Error(`${name}: the scan failed (${result.failed})`)
			}
			check(result)
			last = result
		}
		times.sort((a, b) => a - b)
		report[name] = {
			bytes: bytes.byteLength,
			medianMs: Math.round(times[Math.floor(RUNS / 2)] ?? 0),
			elements: last?.work.elements ?? 0,
			textChunks: last?.work.textChunks ?? 0,
		}
	}
	console.log(JSON.stringify({ webPageScan: report }))
})
