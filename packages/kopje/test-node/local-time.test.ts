import { describe, expect, it } from 'vitest'

import { LOCAL_TIME, rewriteLocalTimes } from '../src/client/local-time.js'
import { calendarDate, instant } from '../src/web/format.js'

// The local-time rewrite (design §7.6) on stub elements: which <time> it rewrites, to what, and what it never touches.
// The browser job runs the real bundle in Chromium under the zones and the production CSP.

// A <time> as the rewrite sees it: its attributes, its text, and every attribute write (none is allowed).
class Time {
	textContent: string
	readonly writes: string[] = []
	constructor(
		readonly attributes: Record<string, string>,
		text: string
	) {
		this.textContent = text
	}
	getAttribute(name: string): string | null {
		return this.attributes[name] ?? null
	}
	setAttribute(name: string): void {
		this.writes.push(name)
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

const local = (datetime: string, text = instant(datetime)) => new Time({ datetime, 'data-local': '' }, text)
const inZone = (timeZone: string) => new Intl.DateTimeFormat('en', { ...LOCAL_TIME, timeZone })

describe('the local-time rewrite', () => {
	it('formats with the server’s options but the zone: under UTC it writes exactly the server’s text', () => {
		expect(LOCAL_TIME).not.toHaveProperty('timeZone')
		const isos = [
			'2026-10-23T14:32:00.000Z',
			'2026-10-23T14:32:07Z',
			'2026-10-23T14:32Z',
			'2026-01-02T03:04:05.123456Z',
		]
		const times = isos.map((iso) => local(iso, 'server text'))
		rewriteLocalTimes(page(times), inZone('UTC'))
		expect(times.map((time) => time.textContent)).toEqual(isos.map(instant))
		expect(times[0]!.textContent).toBe('Oct 23, 2026, 14:32 UTC')
	})

	it('moves an instant at 23:30 UTC across the date line by the viewer’s zone, and names the zone', () => {
		const cases: [zone: string, text: string][] = [
			['Asia/Tokyo', 'Oct 24, 2026, 08:30 GMT+9'],
			['America/Los_Angeles', 'Oct 23, 2026, 16:30 PDT'],
			// After the change to standard time, the same wall clock in Los Angeles is an hour earlier.
			['America/Los_Angeles', 'Nov 30, 2026, 15:30 PST'],
		]
		const isos = ['2026-10-23T23:30:00.000Z', '2026-10-23T23:30:00.000Z', '2026-11-30T23:30:00.000Z']
		cases.forEach(([zone, text], i) => {
			const time = local(isos[i]!)
			rewriteLocalTimes(page([time]), inZone(zone))
			expect(time.textContent, zone).toBe(text)
			expect(time.writes).toEqual([])
		})
	})

	it('leaves calendar dates, other forms and unmarked times as rendered, beside an instant it rewrites', () => {
		// The instant shows that the rewrite ran over this page.
		const rewritten = local('2026-10-23T23:30:00.000Z')
		const untouched = [
			// A calendar date never carries data-local; one that did is still never read as an instant.
			new Time({ datetime: '2026-11-01' }, calendarDate('2026-11-01')),
			local('2026-11-01', calendarDate('2026-11-01')),
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
		rewriteLocalTimes(page([rewritten, ...untouched]), inZone('Asia/Tokyo'))
		expect(rewritten.textContent).toBe('Oct 24, 2026, 08:30 GMT+9')
		expect(untouched.map((time) => time.textContent)).toEqual(before)
		expect(untouched[0]!.textContent).toBe('Nov 1, 2026')
		expect([rewritten, ...untouched].flatMap((time) => time.writes)).toEqual([])
	})
})
