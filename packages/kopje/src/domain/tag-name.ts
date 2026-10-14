// The names status_tags holds. No imports: the cutover's converter runs this module from the sources on Node
// (cli/lib/cutover/kopje-runtime.js).

// status_tags.name: NFKC, lowercase.
export function normalizeTag(name: string): string {
	return name.normalize('NFKC').toLowerCase()
}

// The status_tags name of an ActivityPub Hashtag's `name` ("#name"): the one leading # it carries dropped, then
// normalized. A fullwidth or small number sign is part of the name.
export function hashtagObjectName(name: string): string {
	return normalizeTag(name.replace(/^#/, ''))
}
