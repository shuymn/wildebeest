// The language of an ActivityPub object. No imports: the cutover's converter runs this module from the sources on
// Node (cli/lib/cutover/kopje-runtime.js).

// The first tag of its contentMap, else nameMap, else summaryMap, cut to the primary subtag in lowercase, as stored for
// local statuses (ISO 639: two or three letters); else none.
export function languageOf(object: Record<string, unknown>): string | null {
	for (const key of ['contentMap', 'nameMap', 'summaryMap']) {
		const map = object[key]
		const tag = typeof map === 'object' && map !== null && !Array.isArray(map) ? Object.keys(map)[0] : undefined
		if (tag !== undefined) {
			const primary = tag.split(/[-_]/)[0]?.toLowerCase() ?? ''
			return /^[a-z]{2,3}$/.test(primary) ? primary : null
		}
	}
	return null
}
