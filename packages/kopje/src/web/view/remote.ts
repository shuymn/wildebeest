import { address, displayName } from './account'
import type { Account } from '../../domain/accounts'

// What a person follows or opens from their own server (design §8): a local account or status as its page shows it.
export type RemoteTarget = {
	kind: 'account' | 'status'
	// Its ActivityPub id, the `uri` another server's /authorize_interaction takes: the actor URI or the status's URI.
	uri: string
	// What to search for on that server: the account's full address, or the status page's URL.
	search: string
	// Its page, which the handoff goes back to; the handoff is at interactPath(path).
	path: string
	// The account's name, which the follow dialog's title names; null for a status.
	name: string | null
}

export function accountTarget(account: Account, domain: string): RemoteTarget {
	return {
		kind: 'account',
		uri: account.uri,
		search: address(account, domain),
		path: `/@${account.username}`,
		name: displayName(account),
	}
}

export function statusTarget(status: { uri: string; url: string; path: string }): RemoteTarget {
	return { kind: 'status', uri: status.uri, search: status.url, path: status.path, name: null }
}

// The handoff page of a target's page (design §3, §8).
export function interactPath(path: string): string {
	return `${path}/interact`
}

// The page on `host` that the handoff links to: its /authorize_interaction with the target's id, percent-encoded.
export function authorizeInteraction(host: string, uri: string): string {
	return `https://${host}/authorize_interaction?uri=${encodeURIComponent(uri)}`
}
