// Numbers, dates and plurals of the web UI, through Intl only. The formatters are created on first use,
// once per isolate. Every function takes a stored value as it is and never throws: a value it cannot read is shown as
// given.

export type Formats = {
	count: (n: number) => string
	instant: (iso: string) => string
	calendarDate: (date: string) => string
	percent: (ratio: number) => string
}

export type PluralForms = { one: string; other: string }

const LOCALE = 'en'

let numbers: Intl.NumberFormat | undefined
let instants: Intl.DateTimeFormat | undefined
let dates: Intl.DateTimeFormat | undefined
let percents: Intl.NumberFormat | undefined
let plurals: Intl.PluralRules | undefined

// A count: 1,284.
export function count(n: number): string {
	numbers ??= new Intl.NumberFormat(LOCALE)
	return numbers.format(n)
}

// An instant in UTC, "Oct 23, 2026, 14:32 UTC". The page marks it data-local; the client bundle
// (src/client/local-time.ts) formats it again with the same options and the viewer's zone.
export function instant(iso: string): string {
	const time = Date.parse(iso)
	if (Number.isNaN(time)) {
		return iso
	}
	instants ??= new Intl.DateTimeFormat(LOCALE, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
		timeZone: 'UTC',
		timeZoneName: 'short',
	})
	return instants.format(time)
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/

// An instant's calendar date in UTC (YYYY-MM-DD), as a stored calendar date is kept: for a page without the L1 bundle,
// where an instant whose time of day does not matter is shown as a date (calendarDate).
export function utcDate(iso: string): string {
	const time = Date.parse(iso)
	return Number.isNaN(time) ? iso : new Date(time).toISOString().slice(0, 10)
}

// A calendar date (YYYY-MM-DD), "Nov 1, 2026": the same day in every zone, never read as an instant.
export function calendarDate(date: string): string {
	const time = CALENDAR_DATE.test(date) ? Date.parse(`${date}T00:00:00Z`) : Number.NaN
	if (Number.isNaN(time)) {
		return date
	}
	dates ??= new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeZone: 'UTC' })
	return dates.format(time)
}

// A ratio (0 to 1) as a whole percentage, "62%".
export function percent(ratio: number): string {
	percents ??= new Intl.NumberFormat(LOCALE, { style: 'percent', maximumFractionDigits: 0 })
	return percents.format(ratio)
}

// English has two plural categories; another catalogue brings its own forms and rules.
export function plural(n: number, forms: PluralForms): string {
	plurals ??= new Intl.PluralRules(LOCALE)
	return plurals.select(n) === 'one' ? forms.one : forms.other
}

export const FORMATS: Formats = { count, instant, calendarDate, percent }
