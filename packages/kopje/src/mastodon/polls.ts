import { type ApiHandler, authorized, optionalCredential, requestParams, storeCall, userCredential } from './context'
import { mastodonError } from './errors'

// Polls (Mastodon 4.5's Api::V1::PollsController and Api::V1::Polls::VotesController); the Store decides who may see
// and vote (domain/polls.ts).

const NOT_FOUND = () => mastodonError(404, 'Record not found')

// At most this many choices are read from a request (RES-1): a poll has at most 100, and a vote is refused at its
// first choice that fails, so more are never needed.
const MAX_CHOICES_READ = 101

// GET /api/v1/polls/:id: the poll, if the viewer may see its status.
export const showPoll: ApiHandler = async (c, deps) => {
	const credential = optionalCredential(c, deps)
	const poll = authorized(
		await storeCall(c, deps, (s, b) => s.getPoll(b, { credential, id: c.req.param('id') ?? '', now: deps.now() }))
	)
	return poll === null ? NOT_FOUND() : c.json(poll)
}

// POST /api/v1/polls/:id/votes: choices[] are the indexes of the choices voted for. None (an absent or empty list) is
// refused as params.require refuses it.
export const votePoll: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const choices = p
		.getAll('choices')
		.filter((choice) => choice !== '')
		.slice(0, MAX_CHOICES_READ)
	const input = { credential: userCredential(c, deps), id: c.req.param('id') ?? '', choices, now: deps.now() }
	const result = authorized(await storeCall(c, deps, (s, b) => s.vote(b, input)))
	switch (result.status) {
		case 'ok':
			return c.json(result.value)
		case 'not_found':
			return NOT_FOUND()
		case 'forbidden':
			return mastodonError(403, 'This action is not allowed')
		case 'missing':
			return mastodonError(400, 'param is missing or the value is empty or invalid: choices')
		case 'invalid':
			return mastodonError(422, result.error)
	}
}
