import { describe, expect, it } from 'vitest'

import { calendarDate, count, instant, percent, plural } from '../src/web/format'
import { STRINGS } from '../src/web/strings'

// The web UI's formatting (design §9), with workerd's Intl: exact English output (R1).

describe('format', () => {
	it('formats an instant in UTC, with the zone named', () => {
		expect(instant('2026-10-23T14:32:00.000Z')).toBe('Oct 23, 2026, 14:32 UTC')
		expect(instant('2026-10-23T23:30:59Z')).toBe('Oct 23, 2026, 23:30 UTC')
		expect(instant('2026-01-02T00:05:00.000Z')).toBe('Jan 2, 2026, 00:05 UTC')
	})

	it('formats a calendar date as the same day, never as an instant', () => {
		expect(calendarDate('2026-11-01')).toBe('Nov 1, 2026')
		expect(calendarDate('2026-12-31')).toBe('Dec 31, 2026')
		// An instant is not a calendar date.
		expect(calendarDate('2026-11-01T00:00:00Z')).toBe('2026-11-01T00:00:00Z')
	})

	it('shows a stored value it cannot read as given, and never throws', () => {
		expect(instant('now')).toBe('now')
		expect(instant('')).toBe('')
		expect(calendarDate('2026-13-45')).toBe('2026-13-45')
		expect(calendarDate('2026-11-1')).toBe('2026-11-1')
	})

	it('formats counts, percentages and plurals', () => {
		expect(count(0)).toBe('0')
		expect(count(1284)).toBe('1,284')
		expect(count(2_000_000)).toBe('2,000,000')
		expect(percent(0.62)).toBe('62%')
		expect(percent(0)).toBe('0%')
		expect(percent(1)).toBe('100%')
		expect(plural(1, { one: 'reply', other: 'replies' })).toBe('reply')
		for (const n of [0, 2, 1284]) {
			expect(plural(n, { one: 'reply', other: 'replies' }), String(n)).toBe('replies')
		}
	})

	it('builds the catalogue’s counted labels from them', () => {
		expect(STRINGS.counts.replies(1)).toBe('1 reply')
		expect(STRINGS.counts.replies(0)).toBe('0 replies')
		expect(STRINGS.counts.boosts(1284)).toBe('1,284 boosts')
		expect(STRINGS.counts.favourites(1)).toBe('1 favourite')
		expect(STRINGS.counts.quotes(2)).toBe('2 quotes')
		expect(STRINGS.settings.otherSessions(1)).toBe('1 other web session is active.')
		expect(STRINGS.settings.otherSessions(3)).toBe('3 other web sessions are active.')
		expect(STRINGS.profile.title('Alice', '@alice@kopje.test')).toBe('Alice (@alice@kopje.test)')
		expect(STRINGS.a11y.openOn('remote.example')).toBe('Open on remote.example')
	})
})

// Counts are lowercase everywhere (docs/web-pages.md, "UI rules"): every function of the catalogue that counts.
describe('counts in the catalogue', () => {
	it('are lowercase for none, one and many', () => {
		const counters: [string, (n: number) => string][] = [
			...Object.entries(STRINGS.counts),
			...Object.entries(STRINGS.profile.units),
			['featured.posts', STRINGS.featured.posts],
			['poll.people', STRINGS.poll.people],
			['poll.votes', STRINGS.poll.votes],
			['settings.otherSessions', STRINGS.settings.otherSessions],
		]
		expect(counters.length).toBeGreaterThan(10)
		for (const [name, counter] of counters) {
			for (const n of [0, 1, 2, 1234]) {
				const text = counter(n)
				expect(text, `${name}(${n})`).toMatch(/\p{L}/u)
				expect(text, `${name}(${n})`).toBe(text.toLowerCase())
			}
		}
	})
})
