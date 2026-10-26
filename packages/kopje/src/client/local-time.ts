// The local-time rewrite (design §7.6): the server renders each instant as <time datetime="…Z" data-local> with its
// text in UTC (src/web/format.ts, instant); this shows it again in the viewer's zone. Only the text changes: the
// datetime attribute is never written, and a value that is not a full UTC instant, such as a calendar date, is left
// as rendered.

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

export function rewriteLocalTimes(root: ParentNode, format: Intl.DateTimeFormat): void {
	for (const time of root.querySelectorAll('time[data-local]')) {
		const iso = time.getAttribute('datetime')
		const at = iso !== null && INSTANT.test(iso) ? Date.parse(iso) : Number.NaN
		if (!Number.isNaN(at)) {
			time.textContent = format.format(at)
		}
	}
}
