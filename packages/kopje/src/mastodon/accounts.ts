import {
	type ApiContext,
	type ApiDeps,
	type ApiHandler,
	authorized,
	credential,
	credential as tokenCredential,
	optionalCredential,
	optionalTokenCredential,
	present,
	refuseAfterAuth,
	requestJobsSoon,
	requestParams,
	storeCall,
	userCredential,
} from './context'
import { mastodonError } from './errors'
import {
	discardProfileUploads,
	type Failure,
	type ProfileUpload,
	storeProfileImage,
	sweepSoon,
	type UploadContext,
} from './media'
import { pageQuery, pageResponse, unlimitedResponse } from './pagination'
import { limitParam, mediaTypeOf, offsetParam, type Params, parseBoolean, readParams } from './params'
import { MAX_SEARCH_OFFSET, searchParams } from './search'
import {
	type CredentialChanges,
	type ProfileImages,
	type FieldSource,
	MAX_ACCOUNTS_BY_ID,
	MAX_ATTRIBUTION_DOMAINS,
	MAX_FIELD_NAME,
	MAX_FIELD_VALUE,
	MAX_FIELDS,
	type RelationshipResult,
	type Visibility,
} from '../domain/accounts'
import { QUOTE_POLICY_NAMES, type QuotePolicyName } from '../domain/audience'
import type { UserCredential } from '../domain/auth'
import { DIRECTORY_DEFAULT_LIMIT, DIRECTORY_MAX_LIMIT } from '../domain/directory'
import { PROFILE_IMAGES, type ProfileImage } from '../domain/media'
import { PROFILE_IMAGE_LIMIT, PROFILE_TOO_LARGE, profileImageProblem, SIGNATURE_BYTES } from '../platform/images'
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
	// UserSettings' default_quote_policy (public, followers or nobody). Mastodon raises on any other value (an error
	// answered 500); Kopje refuses it as it refuses another privacy.
	const quotePolicy = p.get('source[quote_policy]')
	if (quotePolicy !== undefined) {
		if (!QUOTE_POLICY_NAMES.includes(quotePolicy as QuotePolicyName)) {
			problems.push('Quote policy is not included in the list')
		}
		changes.quotePolicy = quotePolicy as QuotePolicyName
	}
	const language = p.get('source[language]')
	if (language !== undefined) {
		if (language !== '' && !LANGUAGE.test(language)) {
			problems.push('Language is not a valid language code')
		}
		changes.language = language === '' ? null : language
	}
	// fields_attributes replaces every field; a pair with both parts blank is dropped, as Mastodon does. An empty JSON
	// object (`{}`, `{"0":{}}`) is a sent, empty hash, which clears them (Account#fields_attributes=).
	if (p.has('fields_attributes') || p.sentObject('fields_attributes') || p.objects('fields_attributes').length > 0) {
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
	const attribution = p.list('attribution_domains')
	if (attribution !== undefined) {
		const domains = normalizeAttributionDomains(attribution)
		for (const domain of domains.filter((d) => !compliantDomain(d))) {
			problems.push(`Attribution domains ${domain} is not a valid domain name`)
		}
		if (domains.length > MAX_ATTRIBUTION_DOMAINS) {
			problems.push(`Attribution domains is too long (maximum is ${MAX_ATTRIBUTION_DOMAINS} characters)`)
		}
		changes.attributionDomains = domains
	}
	changes.locked = parseBoolean(p.get('locked'))
	changes.bot = parseBoolean(p.get('bot'))
	changes.discoverable = parseBoolean(p.get('discoverable'))
	changes.indexable = parseBoolean(p.get('indexable'))
	changes.hideCollections = parseBoolean(p.get('hide_collections'))
	changes.sensitive = parseBoolean(p.get('source[sensitive]'))
	return { changes, problems }
}

// Account::AttributionDomains' normalization: each value stripped of surrounding whitespace and of an http://,
// https:// and *. prefix, blanks dropped, duplicates removed. Values are kept as written otherwise.
export function normalizeAttributionDomains(values: readonly string[]): string[] {
	const domains = values
		.map((value) =>
			value
				.replace(/^[\t\n\v\f\r \0]+|[\t\n\v\f\r \0]+$/g, '')
				.replace(/^http:\/\//, '')
				.replace(/^https:\/\//, '')
				.replace(/^\*\./, '')
		)
		.filter((value) => value !== '')
	return [...new Set(domains)]
}

const MAX_DOMAIN_LENGTH = 256
const DOMAIN_LABEL = /^[a-z0-9-]{1,63}$/

// DomainValidator#compliant?: the host, lowercased and IDNA-encoded, shorter than 256 characters, of labels of 1 to 63
// letters, digits and hyphens (a trailing dot is allowed, as Ruby's split drops the empty label after it). A value
// with a character a host cannot hold (Addressable::URI::InvalidURIError) is not compliant.
export function compliantDomain(value: string): boolean {
	let host: string
	if (/^[\x21-\x7e]*$/.test(value)) {
		host = value.toLowerCase()
	} else if ([...value].some((c) => c <= ' ' || c === '\x7f' || '/\\?#@:"<>{}'.includes(c))) {
		return false
	} else {
		const hostname = URL.parse(`https://${value}/`)?.hostname
		if (hostname === undefined) {
			return false
		}
		host = hostname
	}
	const labels = host.split('.')
	while (labels.length > 0 && labels.at(-1) === '') {
		labels.pop()
	}
	return host.length < MAX_DOMAIN_LENGTH && labels.every((label) => DOMAIN_LABEL.test(label))
}

const PROFILE_FILES = { names: PROFILE_IMAGES, maxBytes: PROFILE_IMAGE_LIMIT }

const IMAGE_ATTRIBUTE: Record<ProfileImage, string> = { avatar: 'Avatar', header: 'Header' }

// The avatar and header files of a credentials form (multipart), checked as Paperclip validates them before anything
// is reserved, each problem with Mastodon's message; or 'string' for a file parameter sent as a non-empty text value
// (Paperclip has no handler for it: 400). An empty value reads as absent. Only a file's first bytes are read here.
export async function profileFiles(
	p: Params
): Promise<{ images: Partial<Record<ProfileImage, File>>; problems: string[] } | 'string'> {
	const images: Partial<Record<ProfileImage, File>> = {}
	const problems: string[] = []
	for (const kind of PROFILE_IMAGES) {
		if ((p.get(kind) ?? '') !== '') {
			return 'string'
		}
		const file = p.file(kind)
		if (file === undefined) {
			continue
		}
		const problem =
			file.size >= PROFILE_IMAGE_LIMIT
				? PROFILE_TOO_LARGE
				: profileImageProblem(new Uint8Array(await file.slice(0, SIGNATURE_BYTES).arrayBuffer()))
		if (problem !== null) {
			problems.push(`${IMAGE_ATTRIBUTE[kind]} ${problem}`)
		} else {
			images[kind] = file
		}
	}
	return { images, problems }
}

// Each image through the upload pipeline (mastodon/media.ts storeProfileImage), in turn, its bytes read only then; the
// uploads made so far are passed to `owned` as they complete, so the caller can discard them if the request fails.
export async function storeProfileImages(
	c: UploadContext,
	deps: ApiDeps,
	credential: () => UserCredential,
	images: Partial<Record<ProfileImage, File>>,
	owned: ProfileUpload[]
): Promise<ProfileImages | Failure> {
	const ids: ProfileImages = {}
	for (const kind of PROFILE_IMAGES) {
		const file = images[kind]
		if (file === undefined) {
			continue
		}
		const stored = await storeProfileImage(c, deps, credential, new Uint8Array(await file.arrayBuffer()))
		if (!stored.ok) {
			return { status: stored.status, error: profileFailure(kind, stored.error) }
		}
		owned.push(stored.upload)
		ids[kind] = stored.upload.id
	}
	return ids
}

// The media pipeline's messages name the attribute `File`; a profile image's name it.
function profileFailure(kind: ProfileImage, error: string): string {
	return error.replace('Validation failed: File ', `Validation failed: ${IMAGE_ATTRIBUTE[kind]} `)
}

// PATCH /api/v1/accounts/update_credentials. A multipart body may carry the avatar and header files, so its token is
// checked before the body is read (an invalid or under-scoped token reads no 17.9 MB body); text, then images, are
// validated before anything is reserved, and the Store applies everything in one transaction (D3).
export const updateCredentials: ApiHandler = async (c, deps) => {
	const multipart = mediaTypeOf(c.req.header('content-type')) === 'multipart/form-data'
	if (multipart) {
		const value = credential(c, deps)
		authorized(await storeCall(c, deps, (s, b) => s.checkCredential(b, value)))
	}
	const read = await readParams(c.req.raw, { files: PROFILE_FILES })
	if (!read.ok) {
		const response = mastodonError(
			read.status,
			read.status === 413 ? 'Request body is too large' : 'Malformed request body'
		)
		return multipart ? response : refuseAfterAuth(c, deps, response)
	}
	const p = read.params
	const { changes, problems } = credentialChanges(p)
	const files = await profileFiles(p)
	if (files === 'string') {
		return refuseAfterAuth(c, deps, mastodonError(400, 'Bad Request'))
	}
	problems.push(...files.problems)
	if (problems.length > 0) {
		return refuseAfterAuth(c, deps, mastodonError(422, `Validation failed: ${problems.join(', ')}`))
	}
	const owned: ProfileUpload[] = []
	let committed = false
	try {
		const images = await storeProfileImages(c, deps, () => userCredential(c, deps), files.images, owned)
		if ('error' in images) {
			return mastodonError(images.status, images.error)
		}
		const value = userCredential(c, deps)
		const result = authorized(
			await storeCall(c, deps, (s, b) =>
				s.updateCredentials(b, { credential: value, changes, images, present: present(c), now: deps.now() })
			)
		)
		if (result.status === 'upload_gone') {
			return mastodonError(422, 'Validation failed: The upload expired')
		}
		if (result.status === 'not_found') {
			return NOT_FOUND()
		}
		committed = true
		if (owned.length > 0) {
			// The replaced images' uploads go with the sweep.
			sweepSoon(c, deps)
		}
		if (result.accepting) {
			requestJobsSoon(c, deps)
		}
		return c.json(result.account)
	} finally {
		if (!committed) {
			await discardProfileUploads(c, deps, owned)
		}
	}
}

// DELETE /api/v1/profile/avatar and /api/v1/profile/header: the account shows the default image again and other
// servers receive the Update; the removed image's files go with the sweep after the response.
function removeProfileImage(kind: ProfileImage): ApiHandler {
	return async (c, deps) => {
		const credential = userCredential(c, deps)
		const account = authorized(
			await storeCall(c, deps, (s, b) =>
				s.removeProfileImage(b, { credential, kind, present: present(c), now: deps.now() })
			)
		)
		if (account === null) {
			return NOT_FOUND()
		}
		sweepSoon(c, deps)
		return c.json(account)
	}
}

export const removeAvatar = removeProfileImage('avatar')
export const removeHeader = removeProfileImage('header')

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
	const result = authorized(await storeCall(c, deps, (s, b) => s.follow(b, input)))
	return result.status === 'invalid' ? validationError(result.errors) : relationshipResponse(c, result)
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
// every one at once with limit=0, without them. Kopje's limit=0 answer stops at MAX_ENDORSEMENTS_ANSWERED and
// ANSWER_BYTES (8 MiB, RES-3); one cut by the bytes links next to the rest (unlimitedResponse).
export const endorsements: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const query = pageQuery(p)
	const page = p.get('limit') === '0' ? null : query
	const input = { credential: userCredential(c, deps), page, from: query.maxId, present: present(c) }
	const result = authorized(await storeCall(c, deps, (s, b) => s.listEndorsements(b, input)))
	return page === null ? unlimitedResponse(c, result) : pageResponse(c, result, page.limit)
}

// GET /api/v1/directory (Api::V1::DirectoriesController#show, domain/directory.ts). Parameters as Mastodon reads them:
// `order` new or active (the default; Kopje reads any other value as active, where Mastodon fails), `local` as a
// Rails boolean, `offset` (a negative or unreadable one is 0), and `limit` as limit_param (the absolute value, at
// most 80; 0 or an unreadable one answers no accounts). Without a token, the answer may be cached by anyone for 15
// seconds (cache_if_unauthenticated!), varying by Authorization as every Mastodon API answer does.
export const directory: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const credential = optionalTokenCredential(c, deps)
	const input = {
		credential,
		order: p.get('order') === 'new' ? ('new' as const) : ('active' as const),
		local: parseBoolean(p.get('local')) ?? false,
		offset: offsetParam(p),
		limit: limitParam(p, DIRECTORY_DEFAULT_LIMIT, DIRECTORY_MAX_LIMIT),
		now: deps.now(),
		present: present(c),
	}
	const accounts = authorized(await storeCall(c, deps, (s, b) => s.directory(b, input)))
	return credential === null
		? c.json(accounts, 200, {
				'cache-control': 'public, max-age=15, stale-while-revalidate=30, stale-if-error=86400',
				vary: 'Authorization',
			})
		: c.json(accounts)
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
		return pageResponse(c, result, page.limit)
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
	return pageResponse(c, result, page.limit)
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
