import {
	type ApiContext,
	type ApiHandler,
	authorized,
	credential as tokenCredential,
	optionalCredential,
	present,
	refuseAfterAuth,
	requestParams,
	storeCall,
	userCredential,
} from './context'
import { mastodonError } from './errors'
import { linkHeader, pageQuery, pageResponse } from './pagination'
import { type Params, parseBoolean } from './params'
import { MAX_SEARCH_OFFSET, searchParams } from './search'
import {
	type CredentialChanges,
	type FieldSource,
	MAX_ACCOUNTS_BY_ID,
	MAX_FIELD_NAME,
	MAX_FIELD_VALUE,
	MAX_FIELDS,
	type RelationshipResult,
	type Visibility,
} from '../domain/accounts'
import { grantsAny } from '../security/scopes'

// /api/v1/accounts (B3): credentials, lookup, search, relationships, follow, follower lists, notes and endorsements.

const NOT_FOUND = () => mastodonError(404, 'Record not found')

export const verifyCredentials: ApiHandler = async (c, deps) => {
	const credential = userCredential(c, deps)
	const account = authorized(
		await storeCall(c, deps, (s, b) => s.verifyCredentials(b, { credential, present: present(c) }))
	)
	return account === null ? NOT_FOUND() : c.json(account)
}

const MAX_DISPLAY_NAME = 30
const MAX_NOTE = 500
const VISIBILITIES: readonly string[] = ['public', 'unlisted', 'private', 'direct']
const LANGUAGE = /^[a-z]{2,3}$/

function characters(text: string): number {
	return [...text].length
}

// The changes update_credentials asks for, and the validation problems with them (Mastodon's messages). Shared by the
// API and the settings page (app/web.tsx), which posts the same names. Avatar and header come through the media
// pipeline on the settings page only.
export function credentialChanges(p: Params): { changes: CredentialChanges; problems: string[] } {
	const changes: CredentialChanges = {}
	const problems: string[] = []
	const displayName = p.get('display_name')
	if (displayName !== undefined) {
		if (characters(displayName) > MAX_DISPLAY_NAME) {
			problems.push(`Display name is too long (maximum is ${MAX_DISPLAY_NAME} characters)`)
		}
		changes.displayName = displayName
	}
	const note = p.get('note')
	if (note !== undefined) {
		if (characters(note) > MAX_NOTE) {
			problems.push(`Note is too long (maximum is ${MAX_NOTE} characters)`)
		}
		changes.note = note
	}
	const privacy = p.get('source[privacy]')
	if (privacy !== undefined) {
		if (!VISIBILITIES.includes(privacy)) {
			problems.push('Privacy is not included in the list')
		}
		changes.privacy = privacy as Visibility
	}
	const language = p.get('source[language]')
	if (language !== undefined) {
		if (language !== '' && !LANGUAGE.test(language)) {
			problems.push('Language is not a valid language code')
		}
		changes.language = language === '' ? null : language
	}
	// fields_attributes replaces every field; a pair with both parts blank is dropped, as Mastodon does.
	if (p.has('fields_attributes') || p.objects('fields_attributes').length > 0) {
		const fields: FieldSource[] = p
			.objects('fields_attributes')
			.map((field) => ({ name: (field.name ?? '').trim(), value: (field.value ?? '').trim() }))
			.filter((field) => field.name !== '' || field.value !== '')
		if (fields.length > MAX_FIELDS) {
			problems.push(`Fields is too long (maximum is ${MAX_FIELDS} fields)`)
		}
		if (fields.some((field) => characters(field.name) > MAX_FIELD_NAME || characters(field.value) > MAX_FIELD_VALUE)) {
			problems.push(`Fields is too long (maximum is ${MAX_FIELD_NAME} characters each)`)
		}
		changes.fields = fields
	}
	changes.locked = parseBoolean(p.get('locked'))
	changes.bot = parseBoolean(p.get('bot'))
	changes.discoverable = parseBoolean(p.get('discoverable'))
	changes.hideCollections = parseBoolean(p.get('hide_collections'))
	changes.sensitive = parseBoolean(p.get('source[sensitive]'))
	return { changes, problems }
}

export const updateCredentials: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const { changes, problems } = credentialChanges(p)
	if (problems.length > 0) {
		return refuseAfterAuth(c, deps, mastodonError(422, `Validation failed: ${problems.join(', ')}`))
	}
	const credential = userCredential(c, deps)
	const account = authorized(
		await storeCall(c, deps, (s, b) =>
			s.updateCredentials(b, { credential, changes, present: present(c), now: deps.now() })
		)
	)
	return account === null ? NOT_FOUND() : c.json(account)
}

export const getAccount: ApiHandler = async (c, deps) => {
	const id = c.req.param('id') ?? ''
	const account = await storeCall(c, deps, (s, b) => s.getAccount(b, { id, present: present(c) }))
	return account === null ? NOT_FOUND() : c.json(account)
}

// GET /api/v1/accounts?id[]= (AccountsController#index): the accounts getAccount would show, in one read. More than
// DEFAULT_ACCOUNTS_LIMIT distinct ids raise Mastodon::ValidationError, which answers 422 with the class's name.
export const getAccounts: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const ids = [...new Set(p.getAll('id'))]
	if (ids.length > MAX_ACCOUNTS_BY_ID) {
		return mastodonError(422, 'Mastodon::ValidationError')
	}
	return c.json(await storeCall(c, deps, (s, b) => s.getAccounts(b, { ids, present: present(c) })))
}

// POST /api/v1/accounts (AccountsController#create): Kopje has no open registration, so it answers as Mastodon does
// with registrations closed, after Mastodon's checks in their order: the token (doorkeeper_authorize! :write,
// :'write:accounts'), then an app token (require_client_credentials!), then check_enabled_registrations's `forbidden`.
export const register: ApiHandler = async (c, deps) => {
	const value = tokenCredential(c, deps)
	const viewer = authorized(await storeCall(c, deps, (s, b) => s.checkCredential(b, value)))
	if (!grantsAny(viewer.scopes, 'write:accounts')) {
		authorized({ status: 'insufficient_scope' })
	}
	if (viewer.accountId !== null) {
		return mastodonError(403, 'This method requires an client credentials authentication')
	}
	return mastodonError(403, 'Forbidden')
}

// acct is "user" or "user@domain"; the instance's own host means a local account.
export const lookupAccount: ApiHandler = async (c, deps) => {
	const acct = (c.req.query('acct') ?? '').trim().replace(/^@/, '')
	const at = acct.indexOf('@')
	const username = at === -1 ? acct : acct.slice(0, at)
	const host = at === -1 ? null : acct.slice(at + 1).toLowerCase()
	if (username === '' || host === '') {
		return NOT_FOUND()
	}
	const domain = host === null || host === new URL(c.req.url).host ? null : host
	const account = await storeCall(c, deps, (s, b) => s.lookupAccount(b, { username, domain, present: present(c) }))
	return account === null ? NOT_FOUND() : c.json(account)
}

export const relationships: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const ids = p.getAll('id')
	const credential = userCredential(c, deps)
	return c.json(authorized(await storeCall(c, deps, (s, b) => s.relationships(b, { credential, ids }))))
}

export const searchAccounts: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const parsed = searchParams(p)
	if ('error' in parsed) {
		return refuseAfterAuth(c, deps, parsed.error)
	}
	const { limit } = pageQuery(p)
	const credential = userCredential(c, deps)
	if (parsed.offset > MAX_SEARCH_OFFSET) {
		authorized(await storeCall(c, deps, (s, b) => s.checkCredential(b, credential)))
		return c.json([])
	}
	const accounts = await storeCall(c, deps, (s, b) =>
		s.searchAccounts(b, {
			credential,
			query: parsed.query,
			limit,
			offset: parsed.offset,
			following: parseBoolean(p.get('following')) ?? false,
			localDomain: new URL(c.req.url).host,
			present: present(c),
		})
	)
	return c.json(authorized(accounts))
}

export function relationshipResponse(c: ApiContext, result: RelationshipResult): Response {
	switch (result.status) {
		case 'ok':
			return c.json(result.relationship)
		case 'not_found':
			return NOT_FOUND()
		case 'forbidden':
			return mastodonError(403, 'This action is not allowed')
		case 'unavailable':
			return mastodonError(503, 'This action cannot be recorded right now')
	}
}

export const follow: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	// Absent keeps the follow's filter; an empty list (`languages: []`, `languages[]=`) clears it.
	const languages = p.has('languages') ? p.getAll('languages').filter((language) => language !== '') : undefined
	const input = {
		credential: userCredential(c, deps),
		target: c.req.param('id') ?? '',
		reblogs: parseBoolean(p.get('reblogs')),
		notify: parseBoolean(p.get('notify')),
		languages,
		now: deps.now(),
	}
	return relationshipResponse(c, authorized(await storeCall(c, deps, (s, b) => s.follow(b, input))))
}

export const unfollow: ApiHandler = async (c, deps) => {
	const target = c.req.param('id') ?? ''
	const credential = userCredential(c, deps)
	const input = { credential, target, now: deps.now() }
	return relationshipResponse(c, authorized(await storeCall(c, deps, (s, b) => s.unfollow(b, input))))
}

// POST /api/v1/accounts/:id/remove_from_followers (RemoveFromFollowersService).
export const removeFromFollowers: ApiHandler = async (c, deps) => {
	const input = { credential: userCredential(c, deps), target: c.req.param('id') ?? '', now: deps.now() }
	return relationshipResponse(c, authorized(await storeCall(c, deps, (s, b) => s.removeFromFollowers(b, input))))
}

function validationError(errors: string[]): Response {
	return mastodonError(422, `Validation failed: ${errors.join(', ')}`)
}

// POST /api/v1/accounts/:id/note (Accounts::NotesController): the viewer's private note, `comment`.
export const note: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const input = {
		credential: userCredential(c, deps),
		target: c.req.param('id') ?? '',
		comment: p.get('comment'),
		now: deps.now(),
	}
	const result = authorized(await storeCall(c, deps, (s, b) => s.setNote(b, input)))
	return result.status === 'invalid' ? validationError(result.errors) : relationshipResponse(c, result)
}

// POST /api/v1/accounts/:id/endorse and /pin, /unendorse and /unpin (Accounts::EndorsementsController).
export const endorse: ApiHandler = async (c, deps) => {
	const input = { credential: userCredential(c, deps), target: c.req.param('id') ?? '', now: deps.now() }
	const result = authorized(await storeCall(c, deps, (s, b) => s.endorse(b, input)))
	return result.status === 'invalid' ? validationError(result.errors) : relationshipResponse(c, result)
}

export const unendorse: ApiHandler = async (c, deps) => {
	const input = { credential: userCredential(c, deps), target: c.req.param('id') ?? '', now: deps.now() }
	return relationshipResponse(c, authorized(await storeCall(c, deps, (s, b) => s.unendorse(b, input))))
}

// GET /api/v1/endorsements (EndorsementsController): the viewer's, 40 by default and at most 80 with Link headers, or
// every one at once with limit=0, without them.
export const endorsements: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const page = p.get('limit') === '0' ? null : pageQuery(p)
	const input = { credential: userCredential(c, deps), page, present: present(c) }
	const result = authorized(await storeCall(c, deps, (s, b) => s.listEndorsements(b, input)))
	return page === null ? c.json(result.items) : pageResponse(c, result, page.limit)
}

// GET /api/v1/accounts/:id/endorsements (Accounts::EndorsementsController#index): public.
export const accountEndorsements: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const page = pageQuery(p)
	const input = {
		credential: optionalCredential(c, deps),
		account: c.req.param('id') ?? '',
		page,
		now: deps.now(),
		present: present(c),
	}
	const result = authorized(await storeCall(c, deps, (s, b) => s.accountEndorsements(b, input)))
	return result === null ? NOT_FOUND() : pageResponse(c, result, page.limit)
}

function followList(direction: 'followers' | 'following'): ApiHandler {
	return async (c, deps) => {
		const p = await requestParams(c, deps)
		if (p instanceof Response) {
			return p
		}
		const page = pageQuery(p)
		const credential = optionalCredential(c, deps)
		const result = authorized(
			await storeCall(c, deps, (s, b) =>
				s.listFollows(b, {
					credential,
					account: c.req.param('id') ?? '',
					direction,
					page,
					now: deps.now(),
					present: present(c),
				})
			)
		)
		if (result === null) {
			return NOT_FOUND()
		}
		const link = linkHeader(c.req.url, { ...result, count: result.items.length }, page.limit)
		if (link !== undefined) {
			c.header('Link', link)
		}
		return c.json(result.items)
	}
}

export const followers = followList('followers')
export const following = followList('following')

// /api/v1/follow_requests: the viewer's pending followers, and the decision on one of them (VIS-9).
export const followRequests: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const page = pageQuery(p)
	const credential = userCredential(c, deps)
	const result = authorized(
		await storeCall(c, deps, (s, b) => s.listFollowRequests(b, { credential, page, present: present(c) }))
	)
	const link = linkHeader(c.req.url, { ...result, count: result.items.length }, page.limit)
	if (link !== undefined) {
		c.header('Link', link)
	}
	return c.json(result.items)
}

function answerFollowRequest(decision: 'authorize' | 'reject'): ApiHandler {
	return async (c, deps) => {
		const input = { credential: userCredential(c, deps), account: c.req.param('id') ?? '', decision, now: deps.now() }
		return relationshipResponse(c, authorized(await storeCall(c, deps, (s, b) => s.answerFollowRequest(b, input))))
	}
}

export const authorizeFollowRequest = answerFollowRequest('authorize')
export const rejectFollowRequest = answerFollowRequest('reject')

export const preferences: ApiHandler = async (c, deps) => {
	const credential = userCredential(c, deps)
	const result = authorized(await storeCall(c, deps, (s, b) => s.preferences(b, { credential })))
	return result === null ? NOT_FOUND() : c.json(result)
}

export const familiarFollowers: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const ids = p.getAll('id')
	const credential = userCredential(c, deps)
	return c.json(
		authorized(await storeCall(c, deps, (s, b) => s.familiarFollowers(b, { credential, ids, present: present(c) })))
	)
}
