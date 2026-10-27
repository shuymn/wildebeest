import { describe, expect, it } from 'vitest'

import { LOCAL_TIME, rewriteLocalTimes } from '../src/client/local-time.js'
import { calendarDate, instant } from '../src/web/format.js'

// The local-time rewrite (design §7.6) on stub elements: which <time> it rewrites, to what, and what it never touches.
// The browser job runs the real bundle in Chromium under the zones, a fixed clock and the production CSP.

// A <time> as the rewrite sees it: its attributes, its text, and every attribute write (only title is allowed).
class Time {
	textContent: string
	readonly writes: [name: string, value: string][] = []
	constructor(
		readonly attributes: Record<string, string>,
		text: string
	) {
		this.textContent = text
	}
	getAttribute(name: string): string | null {
		return this.attributes[name] ?? null
	}
	setAttribute(name: string, value: string): void {
		this.writes.push([name, value])
	}
}

// A document holding the times; it answers only the rewrite's selector, as a browser would.
function page(times: Time[]): ParentNode {
	return {
		querySelectorAll(selector: string) {
			expect(selector).toBe('time[data-local]')
			return times.filter((time) => 'data-local' in time.attributes)
		},
	} as unknown as ParentNode
}

const local = (datetime: string, text = instant(datetime), mode = '') =>
	new Time({ datetime, 'data-local': mode }, text)
const fullIn = (timeZone: string) => new Intl.DateTimeFormat('en', { ...LOCAL_TIME, timeZone })

// An instant given as a wall clock in Tokyo (UTC+9 all year, so the arithmetic below is exact).
const tokyo = (wall: string) => new Date(`${wall}+09:00`).toISOString()
const HOUR = 60 * 60 * 1000

// What the rewrite shows for each instant, seen at now in the zone, under a data-local value.
function shown(now: string, isos: string[], mode = '', zone = 'Asia/Tokyo'): string[] {
	const times = isos.map((iso) => local(iso, 'server text', mode))
	rewriteLocalTimes(page(times), Date.parse(now), zone)
	return times.map((time) => time.textContent)
}

describe('the local-time rewrite: the compact shape (data-local="")', () => {
	const now = tokyo('2026-10-24T00:01:00')

	it('shows the time alone within 24 hours on today’s calendar day, past or future', () => {
		expect(shown(now, [tokyo('2026-10-24T00:00:00'), now, tokyo('2026-10-24T23:59:00')])).toEqual([
			'00:00',
			'00:01',
			'23:59',
		])
	})

	it('shows date and time within 24 hours on another calendar day of the viewer’s zone, though UTC’s is the same', () => {
		// 23:59 in Tokyo seen at 00:01 the next day: both are Oct 23 in UTC.
		expect(new Date(now).getUTCDate()).toBe(new Date(tokyo('2026-10-23T23:59:00')).getUTCDate())
		expect(shown(now, [tokyo('2026-10-23T23:59:00'), tokyo('2026-10-25T00:00:00')])).toEqual([
			'Oct 23, 23:59',
			'Oct 25, 00:00',
		])
	})

	it('drops the year within 24 hours across a new year', () => {
		expect(shown(tokyo('2027-01-01T00:01:00'), [tokyo('2026-12-31T23:59:00')])).toEqual(['Dec 31, 23:59'])
		expect(shown(tokyo('2026-12-31T23:59:00'), [tokyo('2027-01-01T00:01:00')])).toEqual(['Jan 1, 00:01'])
	})

	it('counts exactly 24 hours as within, and a millisecond more as further away, either way', () => {
		const at = Date.parse(now)
		const iso = (ms: number) => new Date(ms).toISOString()
		expect(shown(now, [iso(at - 24 * HOUR), iso(at + 24 * HOUR)])).toEqual(['Oct 23, 00:01', 'Oct 25, 00:01'])
		expect(shown(now, [iso(at - 24 * HOUR - 1), iso(at + 24 * HOUR + 1)])).toEqual(['Oct 23', 'Oct 25'])
	})

	it('shows the date without the year further away in the viewer’s calendar year, and with it otherwise', () => {
		expect(
			shown(now, [
				tokyo('2026-10-20T18:30:00'),
				tokyo('2026-01-01T00:00:00'),
				tokyo('2026-12-31T23:59:00'),
				tokyo('2025-12-31T23:59:00'),
				tokyo('2025-10-20T18:30:00'),
				tokyo('2027-01-01T00:00:00'),
			])
		).toEqual(['Oct 20', 'Jan 1', 'Dec 31', 'Dec 31, 2025', 'Oct 20, 2025', 'Jan 1, 2027'])
	})

	it('judges the year in the viewer’s zone: Dec 25 in Tokyo is last year at 00:01 on Jan 1, though UTC’s is the same', () => {
		const newYear = tokyo('2027-01-01T00:01:00')
		expect(new Date(newYear).getUTCFullYear()).toBe(2026)
		expect(shown(newYear, [tokyo('2026-12-25T12:00:00')])).toEqual(['Dec 25, 2026'])
	})

	it('reads the zone it is given: the same instant and now in Los Angeles fall on one calendar day', () => {
		// 23:59 Oct 23 and 00:01 Oct 24 in Tokyo are 07:59 and 08:01 Oct 23 in Los Angeles.
		expect(shown(now, [tokyo('2026-10-23T23:59:00')], '', 'America/Los_Angeles')).toEqual(['07:59'])
	})

	it('treats an unknown data-local value as compact', () => {
		expect(shown(now, [tokyo('2026-10-20T18:30:00')], 'other')).toEqual(['Oct 20'])
	})
})

describe('the local-time rewrite: the exceptions', () => {
	const now = tokyo('2026-10-24T00:01:00')

	it('"full" always shows the full form, near or far', () => {
		expect(shown(now, [now, tokyo('2026-10-20T18:30:00'), tokyo('2025-10-20T18:30:00')], 'full')).toEqual([
			'Oct 24, 2026, 00:01 GMT+9',
			'Oct 20, 2026, 18:30 GMT+9',
			'Oct 20, 2025, 18:30 GMT+9',
		])
	})

	it('"deadline" keeps the time in every shape', () => {
		expect(
			shown(
				now,
				[
					tokyo('2026-10-24T21:00:00'),
					tokyo('2026-10-25T00:00:00'),
					tokyo('2026-10-30T21:00:00'),
					tokyo('2027-10-30T21:00:00'),
					tokyo('2025-10-30T21:00:00'),
				],
				'deadline'
			)
		).toEqual(['21:00', 'Oct 25, 00:00', 'Oct 30, 21:00', 'Oct 30, 2027, 21:00', 'Oct 30, 2025, 21:00'])
	})
})

describe('the local-time rewrite: title and what it leaves alone', () => {
	it('puts the full form in title for every shape and writes no other attribute', () => {
		const now = tokyo('2026-10-24T00:01:00')
		const isos = [now, tokyo('2026-10-20T18:30:00'), tokyo('2025-10-20T18:30:00'), tokyo('2026-10-30T21:00:00')]
		const times = [
			local(isos[0]!),
			local(isos[1]!),
			local(isos[2]!, undefined, 'full'),
			local(isos[3]!, undefined, 'deadline'),
		]
		rewriteLocalTimes(page(times), Date.parse(now), 'Asia/Tokyo')
		expect(times.map((time) => time.writes)).toEqual([
			[['title', 'Oct 24, 2026, 00:01 GMT+9']],
			[['title', 'Oct 20, 2026, 18:30 GMT+9']],
			[['title', 'Oct 20, 2025, 18:30 GMT+9']],
			[['title', 'Oct 30, 2026, 21:00 GMT+9']],
		])
	})

	it('formats title with the server’s options but the zone: under UTC it is exactly the server’s text', () => {
		expect(LOCAL_TIME).not.toHaveProperty('timeZone')
		const isos = [
			'2026-10-23T14:32:00.000Z',
			'2026-10-23T14:32:07Z',
			'2026-10-23T14:32Z',
			'2026-01-02T03:04:05.123456Z',
		]
		const times = isos.map((iso) => local(iso, 'server text'))
		rewriteLocalTimes(page(times), Date.parse('2026-10-23T14:32:00.000Z'), 'UTC')
		expect(times.map((time) => time.writes)).toEqual(isos.map((iso) => [['title', instant(iso)]]))
		expect(times[0]!.writes).toEqual([['title', 'Oct 23, 2026, 14:32 UTC']])
		// Across a change to standard time the zone's name follows the instant.
		const pst = local('2026-11-30T23:30:00.000Z')
		rewriteLocalTimes(page([pst]), Date.parse('2026-10-23T14:32:00.000Z'), 'America/Los_Angeles')
		expect(pst.writes).toEqual([['title', fullIn('America/Los_Angeles').format(Date.parse('2026-11-30T23:30Z'))]])
		expect(pst.writes[0]![1]).toBe('Nov 30, 2026, 15:30 PST')
	})

	it('leaves calendar dates, other forms and unmarked times as rendered, beside an instant it rewrites', () => {
		// The instant shows that the rewrite ran over this page.
		const rewritten = local('2026-10-23T23:30:00.000Z')
		const untouched = [
			// A calendar date never carries data-local; one that did is still never read as an instant.
			new Time({ datetime: '2026-11-01' }, calendarDate('2026-11-01')),
			local('2026-11-01', calendarDate('2026-11-01')),
			local('2026-11-01', calendarDate('2026-11-01'), 'full'),
			// Not a full UTC instant: an offset, no zone, a space, seconds without minutes, a trailing space.
			local('2026-10-23T23:30:00+09:00', 'as rendered'),
			local('2026-10-23T23:30:00', 'as rendered'),
			local('2026-10-23 23:30:00Z', 'as rendered'),
			local('2026-10-23T23Z', 'as rendered'),
			local('2026-10-23T23:30:00Z ', 'as rendered'),
			// Shaped like an instant but no date.
			local('2026-13-45T23:30:00Z', 'as rendered'),
			// No datetime at all.
			new Time({ 'data-local': '' }, 'as rendered'),
			// An instant without data-local (a page's own UTC time).
			new Time({ datetime: '2026-10-23T23:30:00.000Z' }, 'Oct 23, 2026, 23:30 UTC'),
		]
		const before = untouched.map((time) => time.textContent)
		rewriteLocalTimes(page([rewritten, ...untouched]), Date.parse('2026-10-24T00:00:00.000Z'), 'Asia/Tokyo')
		expect(rewritten.textContent).toBe('08:30')
		expect(rewritten.writes).toEqual([['title', 'Oct 24, 2026, 08:30 GMT+9']])
		expect(untouched.map((time) => time.textContent)).toEqual(before)
		expect(untouched[0]!.textContent).toBe('Nov 1, 2026')
		expect(untouched.flatMap((time) => time.writes)).toEqual([])
	})
})
