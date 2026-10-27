import type { Account } from '../accounts'
import { presentStatus } from '../status-presenter'
import { localPageAccount } from './profile'
import { anonymous, localUsername, pageRead } from './site'
import { targetStatus } from './status'

// The target of a handoff page, /@username/interact or /@username/:id/interact (design §8 "Handoff page"): what its
// profile or status page shows, read as the anonymous viewer (VIS-4) by the same reads, so the handoff exists exactly
// when that page does. A suspended account, and every status its page would not show, is not_found here: the handoff
// has no 410. The handoff page names another server's /authorize_interaction with the target's URI; nothing is fetched
// or written.

export type InteractInput = { handle: string; id: string | null; now: number }

export type InteractTarget =
	| { status: 'account'; account: Account }
	// The status's ActivityPub id, its page's URL, and the page's path to go back to.
	| { status: 'status'; uri: string; url: string; path: string }
	| { status: 'not_found' }

export const webInteractTarget = pageRead<InteractInput, InteractTarget>((db, { handle, id, now }, site) => {
	const username = localUsername(handle, site.domain)
	if (username === null || username === '') {
		return { status: 'not_found' }
	}
	if (id === null) {
		const row = localPageAccount(db, username, site)
		return 'account' in row ? { status: 'account', account: row.account } : { status: 'not_found' }
	}
	const row = targetStatus(db, { id, username })
	const status = row === undefined ? null : presentStatus(db, row.id, anonymous(site, now))
	if (row === undefined || status === null || status.url === null) {
		return { status: 'not_found' }
	}
	return { status: 'status', uri: status.uri, url: status.url, path: `/@${row.username}/${status.id}` }
})
