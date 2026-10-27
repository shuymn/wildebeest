// The local-time rewrite (design §7.6): the server renders each instant as <time datetime="…Z" data-local> with its
// text in UTC (src/web/format.ts, instant); this shows it again in the viewer's zone, compacted by its distance from
// the viewer's now. The value of data-local picks the shape (DateTime in src/web/components/basics.tsx); the first rule
// that matches wins:
// - "" or any other value (compact): within 24 hours and on today's calendar day, "18:30"; within 24 hours on another
//   day, "Dec 31, 23:59" (no year, even across a new year); further away in this calendar year, "Oct 20"; otherwise
//   "Oct 20, 2025".
// - "full": the full form, "Oct 20, 2026, 18:30 GMT+9" (the status page's own date, edit-history versions).
// - "deadline": as compact, but every date keeps its time: "21:00", "Oct 30, 21:00", "Oct 30, 2027, 21:00".
// The full form is always reachable: a compact time shows its text aria-hidden beside the full form in a visually
// hidden span (.vh) for screen readers, title repeats it on hover, and for keyboard and touch a feed's date links to
// the post's page, which shows it in full. Both spans are built with createElement and textContent, so no HTML sink is
// used (Trusted Types, no policy). Calendar days and years are the viewer's zone's. Only the content and title change:
// the datetime attribute is never written, and a value that is not a full UTC instant, such as a calendar date, is
// left as rendered.

// A full UTC instant, as the server writes datetime: a date, hours and minutes, optional seconds and fraction, and Z.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/

// The server's options for an instant without its timeZone, so the result is in the viewer's zone and names it.
export const LOCAL_TIME: Intl.DateTimeFormatOptions = {
	year: 'numeric',
	month: 'short',
	day: 'numeric',
	hour: '2-digit',
	minute: '2-digit',
	hourCycle: 'h23',
	timeZoneName: 'short',
}

// 24 hours in milliseconds: an instant at most this far from now, either way, is near.
const NEAR_MS = 24 * 60 * 60 * 1000

// now is in milliseconds since the epoch; timeZone is the viewer's when undefined (tests fix both).
export function rewriteLocalTimes(root: ParentNode, now: number, timeZone?: string): void {
	const shape = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en', { ...options, timeZone })
	const clock: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
	const full = shape(LOCAL_TIME)
	const time = shape(clock)
	const dayTime = shape({ month: 'short', day: 'numeric', ...clock })
	const day = shape({ month: 'short', day: 'numeric' })
	const date = shape({ year: 'numeric', month: 'short', day: 'numeric' })
	const dateTime = shape({ year: 'numeric', month: 'short', day: 'numeric', ...clock })
	// The date shape names an instant's calendar day in the zone, and its year part the calendar year.
	const year = (at: number) => date.formatToParts(at).find((part) => part.type === 'year')?.value
	const today = date.format(now)
	const thisYear = year(now)
	for (const element of root.querySelectorAll('time[data-local]')) {
		const iso = element.getAttribute('datetime')
		const at = iso !== null && INSTANT.test(iso) ? Date.parse(iso) : Number.NaN
		if (Number.isNaN(at)) {
			continue
		}
		const mode = element.getAttribute('data-local')
		const deadline = mode === 'deadline'
		const near = Math.abs(at - now) <= NEAR_MS
		let shown: Intl.DateTimeFormat
		if (mode === 'full') {
			shown = full
		} else if (near && date.format(at) === today) {
			shown = time
		} else if (near) {
			shown = dayTime
		} else if (year(at) === thisYear) {
			shown = deadline ? dayTime : day
		} else {
			shown = deadline ? dateTime : date
		}
		const whole = full.format(at)
		if (shown === full) {
			element.textContent = whole
		} else {
			// The compact text is for the eye; assistive technology reads the full form beside it, which a selection
			// leaves out (time > .vh in src/web/kopje.css).
			const visible = element.ownerDocument.createElement('span')
			visible.setAttribute('aria-hidden', 'true')
			visible.textContent = shown.format(at)
			const spoken = element.ownerDocument.createElement('span')
			spoken.setAttribute('class', 'vh')
			spoken.textContent = whole
			element.replaceChildren(visible, spoken)
		}
		element.setAttribute('title', whole)
	}
}
