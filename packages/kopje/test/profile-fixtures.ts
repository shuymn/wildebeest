import { sql } from './api-helpers'
import { LEGACY } from './federation-helpers'
import { community, remoteAccount, remoteFollows } from './status-helpers'
import { MAX_REMOTE_FIELDS, REMOTE_FIELDS_BYTES } from '../src/domain/accounts'
import { sanitizeRemoteBio } from '../src/security/html'

// Remote profile parts at their bounds (RES-2), shared by the answer-size tests, and a local profile with a remote
// follower, shared by the profile credential tests.

// alice with the legacy public key and a remote follower (fan@fans.example), so her profile Updates are recorded.
export async function aliceWithFollower(deps: Parameters<typeof community>[2] = {}, scope = 'read write follow') {
	const h = await community(['alice'], scope, deps)
	await sql(h.store, 'UPDATE local_accounts SET pubkey = ?', LEGACY.pubkey)
	await remoteFollows(h.store, await remoteAccount(h.store, 'fan', 'fans.example'), h.users.alice.id)
	return h
}

// One profile field of an actor document.
export const field = (name: string, value: string) => ({ type: 'PropertyValue', name, value })

// A bio of REMOTE_BIO_BYTES as a JSON string: control characters that escape to six bytes, among links the sanitizer
// grows.
export const MAX_BIO = sanitizeRemoteBio(`<p>${'\u0001"<a>x</a>'.repeat(20_000)}</p>`)

// MAX_REMOTE_FIELDS fields of names and values at their read bounds, about REMOTE_FIELDS_BYTES of JSON.
export const maxFields = () => Array.from({ length: MAX_REMOTE_FIELDS }, () => field('n'.repeat(255), 'v'.repeat(4096)))

// The largest attachment a read takes (REMOTE_ATTACHMENT_SQL): seven fields at their name and value bounds, and an
// eighth whose value fills the list's JSON to exactly REMOTE_FIELDS_BYTES.
export function fullestFields() {
	const entry = (value: number) => JSON.stringify({ name: 'n'.repeat(255), value: 'v'.repeat(value) }).length
	const seven = 1 + 7 * (entry(4096) + 1)
	const last = 4096 - (entry(4096) + 1 - (REMOTE_FIELDS_BYTES - seven))
	return [
		...Array.from({ length: 7 }, () => field('n'.repeat(255), 'v'.repeat(4096))),
		field('n'.repeat(255), 'v'.repeat(last)),
	]
}
