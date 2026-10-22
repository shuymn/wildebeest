// A deadline for awaited work (the cutover drain, the media rebuild): past it nothing new is started, and what is
// running is given up. What is given up may still land, so a caller that gives up keeps its lease until it expires.

export class DeadlinePassed extends Error {}

// Runs work, given up once the clock reaches `end` (or not started at all past it).
export async function within<T>(work: () => Promise<T>, end: number, now: () => number): Promise<T> {
	const left = end - now()
	if (left <= 0) {
		throw new DeadlinePassed()
	}
	const running = work()
	running.catch(() => {})
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			running,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new DeadlinePassed()), left)
			}),
		])
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer)
		}
	}
}

// `within`, whose result arriving at or past `end` is not used either: a Store call of a cron round (federation/
// field-links.ts, federation/link-cards.ts) that lands late is treated as given up.
export async function inTime<T>(work: () => Promise<T>, end: number, now: () => number): Promise<T> {
	const result = await within(work, end, now)
	if (now() >= end) {
		throw new DeadlinePassed()
	}
	return result
}
