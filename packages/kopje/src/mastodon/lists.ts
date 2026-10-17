import {
	type ApiContext,
	type ApiHandler,
	authorized,
	present,
	requestParams,
	storeCall,
	userCredential,
} from './context'
import { mastodonError } from './errors'
import { pageQuery, pageResponse, unlimitedResponse } from './pagination'
import { type Params, parseBoolean } from './params'
import type { ListChanges, ListResult, MembersResult } from '../domain/lists'

// Lists (Mastodon 4.5's Api::V1::ListsController, Lists::AccountsController and Accounts::ListsController); the Store
// does the work (domain/lists.ts). A list that is not the viewer's is not found. The list timeline is in timelines.ts.

const NOT_FOUND = () => mastodonError(404, 'Record not found')

// What a create or an update sets: title, replies_policy and exclusive, each when sent (list_params). A blank
// exclusive is not sent.
function listChanges(p: Params): ListChanges {
	return { title: p.get('title'), repliesPolicy: p.get('replies_policy'), exclusive: parseBoolean(p.get('exclusive')) }
}

// The account ids of account_ids[], blanks (an empty list as a form sends it) left out.
function accountIds(p: Params): string[] {
	return p.getAll('account_ids').filter((id) => id !== '')
}

function validationError(errors: string[]): Response {
	return mastodonError(422, `Validation failed: ${errors.join(', ')}`)
}

function listResponse(c: ApiContext, result: ListResult): Response {
	switch (result.status) {
		case 'ok':
			return c.json(result.list)
		case 'not_found':
			return NOT_FOUND()
		case 'invalid':
			return validationError(result.errors)
	}
}

export const lists: ApiHandler = async (c, deps) => {
	const credential = userCredential(c, deps)
	return c.json(authorized(await storeCall(c, deps, (s, b) => s.listLists(b, { credential }))))
}

export const getList: ApiHandler = async (c, deps) => {
	const input = { credential: userCredential(c, deps), id: c.req.param('id') ?? '' }
	const list = authorized(await storeCall(c, deps, (s, b) => s.getList(b, input)))
	return list === null ? NOT_FOUND() : c.json(list)
}

export const createList: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const input = { ...listChanges(p), credential: userCredential(c, deps), now: deps.now() }
	return listResponse(c, authorized(await storeCall(c, deps, (s, b) => s.createList(b, input))))
}

export const updateList: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const input = { ...listChanges(p), credential: userCredential(c, deps), id: c.req.param('id') ?? '' }
	return listResponse(c, authorized(await storeCall(c, deps, (s, b) => s.updateList(b, input))))
}

export const deleteList: ApiHandler = async (c, deps) => {
	const input = { credential: userCredential(c, deps), id: c.req.param('id') ?? '' }
	const deleted = authorized(await storeCall(c, deps, (s, b) => s.deleteList(b, input)))
	return deleted ? c.json({}) : NOT_FOUND()
}

// Lists::AccountsController pages 40 accounts by default and at most 80 (pageQuery's defaults); limit=0 answers every
// member at once, without Link headers (Lists::AccountsController#unlimited?). Kopje's limit=0 answer stops at
// MAX_LIST_MEMBERS_ANSWERED members and ACCOUNT_ANSWER_BYTES (8 MiB, RES-3); one cut by the bytes links next to the
// rest, read by limit=0 with max_id, which Mastodon ignores there (unlimitedResponse).
export const listAccounts: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const unlimited = p.get('limit') === '0'
	const query = pageQuery(p)
	const page = unlimited ? null : query
	const input = {
		credential: userCredential(c, deps),
		id: c.req.param('id') ?? '',
		page,
		from: query.maxId,
		present: present(c),
	}
	const result = authorized(await storeCall(c, deps, (s, b) => s.listAccounts(b, input)))
	if (result === null) {
		return NOT_FOUND()
	}
	return page === null ? unlimitedResponse(c, result) : pageResponse(c, result, page.limit)
}

function membersResponse(c: ApiContext, result: MembersResult): Response {
	switch (result.status) {
		case 'ok':
			return c.json({})
		case 'not_found':
			return NOT_FOUND()
		case 'invalid':
			return validationError(result.errors)
	}
}

export const addListAccounts: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const input = { credential: userCredential(c, deps), id: c.req.param('id') ?? '', accounts: accountIds(p) }
	return membersResponse(c, authorized(await storeCall(c, deps, (s, b) => s.addListAccounts(b, input))))
}

export const removeListAccounts: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const input = { credential: userCredential(c, deps), id: c.req.param('id') ?? '', accounts: accountIds(p) }
	const removed = authorized(await storeCall(c, deps, (s, b) => s.removeListAccounts(b, input)))
	return removed ? c.json({}) : NOT_FOUND()
}

export const accountLists: ApiHandler = async (c, deps) => {
	const input = { credential: userCredential(c, deps), account: c.req.param('id') ?? '' }
	const result = authorized(await storeCall(c, deps, (s, b) => s.accountLists(b, input)))
	return result === null ? NOT_FOUND() : c.json(result)
}
