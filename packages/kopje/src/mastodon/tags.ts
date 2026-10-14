import { type ApiHandler, authorized, optionalTokenCredential, present, storeCall } from './context'
import { mastodonError } from './errors'

// GET /api/v1/tags/:id (domain/tags.ts). A name that is not a hashtag answers 404, as Mastodon's.
export const getTag: ApiHandler = async (c, deps) => {
	const name = c.req.param('id') ?? ''
	const credential = optionalTokenCredential(c, deps)
	const tag = authorized(
		await storeCall(c, deps, (s, b) => s.tag(b, { credential, name, now: deps.now(), present: present(c) }))
	)
	return tag === null ? mastodonError(404, 'Record not found') : c.json(tag)
}
