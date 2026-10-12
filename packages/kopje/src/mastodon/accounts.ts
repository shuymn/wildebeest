import {
	type ApiContext,
	type ApiHandler,
	authorized,
	present,
	refuseAfterAuth,
	requestParams,
	storeCall,
	userCredential,
} from './context'
import { mastodonError } from './errors'
import { linkHeader, pageQuery } from './pagination'
import { type Params, parseBoolean } from './params'
import { MAX_SEARCH_OFFSET, searchParams } from './search'
import {
	type CredentialChanges,
	type FieldSource,
	MAX_FIELD_NAME,
	MAX_FIELD_VALUE,
	MAX_FIELDS,
	type RelationshipResult,
	type Visibility,
} from '../domain/accounts'

// /api/v1/accounts (B3): credentials, lookup, search, relationships, follow, and follower lists.

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

function relationshipResponse(c: ApiContext, result: RelationshipResult): Response {
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

function followList(direction: 'followers' | 'following'): ApiHandler {
	return async (c, deps) => {
		const p = await requestParams(c, deps)
		if (p instanceof Response) {
			return p
		}
		const page = pageQuery(p)
		const result = await storeCall(c, deps, (s, b) =>
			s.listFollows(b, { account: c.req.param('id') ?? '', direction, page, present: present(c) })
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
