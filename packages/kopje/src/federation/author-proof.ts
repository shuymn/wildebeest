import { type DocumentLoader, verifyJsonLd, verifyObject } from '@fedify/fedify'
import { Delete } from '@fedify/vocab'

import { isTransientLoadError, loadFailureOf, RefusedFetchError } from './loader'

// The author's own proof on an activity another server relayed (ID-1's one exception, domain/inbox.ts relayedDelete):
// a Linked Data Signature (RsaSignature2017, as Mastodon signs a stamp's Delete with always_sign) or an FEP-8b32
// Object Integrity Proof. Fedify verifies both; Kopje only chooses the key and compares what was proven with what it
// read:
//   - The key must be one the actor's own document embeds: the verifiers load keys through a loader that serves only
//     that document (fetched and checked as any actor's, inbound.ts), so a key elsewhere, a did:key or a key of
//     another actor is never found. Fedify then requires the key's owner (or controller) to be the activity's actor.
//   - The proven activity, as Fedify parses it (JSON-LD expanded), must be a Delete with exactly the id, actor and
//     object Kopje read from the compacted JSON. Fedify's LD verification refuses @graph, @included and @reverse, and
//     their aliases, before and after compacting the document (the class of bypass Mastodon fixed in 4.5.10,
//     GHSA-53m7-2wrh-q839), and verifies the compacted form it parses; the comparison keeps any other difference
//     between the signed graph and the JSON from reaching the Store.

type Json = Record<string, unknown>

export type ProvenDelete = { id: string; actor: string; object: string }

function withoutFragment(url: string): string {
	const hash = url.indexOf('#')
	return hash === -1 ? url : url.slice(0, hash)
}

// Whether the body carries an author proof at all (an LD signature or an FEP-8b32 proof), valid or not.
export function hasAuthorProof(json: Json): boolean {
	return (json.signature !== undefined && json.signature !== null) || (json.proof !== undefined && json.proof !== null)
}

// The ids of the keys a proof names: the LD signature's creator and every proof's verificationMethod.
function proofKeyIds(json: Json): unknown[] {
	const signature = json.signature as Json | null | undefined
	const proofs = Array.isArray(json.proof)
		? json.proof
		: json.proof === undefined || json.proof === null
			? []
			: [json.proof]
	return [
		...(signature === undefined || signature === null ? [] : [signature.creator]),
		...proofs.map((proof) => (typeof proof === 'object' && proof !== null ? (proof as Json).verificationMethod : null)),
	]
}

// true: proven by a key the actor's document embeds, and the proof covers exactly `expected`; false: no such proof;
// 'transient': a JSON-LD context could not be loaded in a way that may pass.
export async function verifyAuthorProof(
	json: Json,
	expected: ProvenDelete,
	actorDocument: unknown,
	contextLoader: DocumentLoader
): Promise<boolean | 'transient'> {
	const keyIds = proofKeyIds(json)
	if (keyIds.length === 0 || !keyIds.every((id) => typeof id === 'string' && withoutFragment(id) === expected.actor)) {
		return false
	}
	const documentLoader: DocumentLoader = (url) =>
		withoutFragment(url) === expected.actor
			? Promise.resolve({ document: actorDocument, documentUrl: expected.actor, contextUrl: null })
			: Promise.reject(new RefusedFetchError(new URL(url), 'Not the actor document'))
	const options = { documentLoader, contextLoader }
	const matches = (proven: Delete | null) =>
		proven !== null &&
		proven.id?.href === expected.id &&
		proven.actorIds.length === 1 &&
		proven.actorIds[0]?.href === expected.actor &&
		proven.objectIds.length === 1 &&
		proven.objectIds[0]?.href === expected.object
	// Each form on its own: a malformed proof does not hide a valid signature.
	let transient = false
	const attempt = async (verify: () => Promise<boolean>) => {
		try {
			return await verify()
		} catch (error) {
			const failure = loadFailureOf(error)
			transient ||= failure !== undefined && isTransientLoadError(failure)
			return false
		}
	}
	if (
		json.proof !== undefined &&
		json.proof !== null &&
		(await attempt(async () => matches(await verifyObject(Delete, json, options))))
	) {
		return true
	}
	if (
		json.signature !== undefined &&
		json.signature !== null &&
		(await attempt(async () => (await verifyJsonLd(json, options)) && matches(await Delete.fromJsonLd(json, options))))
	) {
		return true
	}
	return transient ? 'transient' : false
}
