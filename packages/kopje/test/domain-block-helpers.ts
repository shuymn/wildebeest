import { runInDurableObject } from 'cloudflare:test'

import { expect } from 'vitest'

import { NOW } from './app-helpers'
import {
	createInstanceDomainBlock,
	deleteInstanceDomainBlock,
	type InstanceDomainBlock,
	type Severity,
	updateInstanceDomainBlock,
} from '../src/domain/instance-domain-blocks'
import type { StoreStub } from '../src/platform/store-client'

// Instance domain blocks through their Store operations (src/domain/instance-domain-blocks.ts): no route creates one
// before the admin API serves them.

const FIELDS = {
	rejectMedia: false,
	rejectReports: false,
	obfuscate: false,
	privateComment: null,
	publicComment: null,
}

// Creates a block of `domain` in a Store's SQLite (inside runInDurableObject); fails the test if it is refused.
export function blockDomainIn(sql: SqlStorage, domain: string, severity: Severity = 'suspend'): InstanceDomainBlock {
	const result = createInstanceDomainBlock.run(sql, { ...FIELDS, domain, severity, now: NOW })
	if (!result.ok) {
		throw new Error(`block of ${domain} refused: ${result.error}`)
	}
	return result.block
}

export function blockDomain(store: StoreStub, domain: string, severity: Severity = 'suspend') {
	return runInDurableObject(store, (_instance, state) => blockDomainIn(state.storage.sql, domain, severity))
}

export async function setSeverity(store: StoreStub, id: number, severity: Severity): Promise<void> {
	const updated = await runInDurableObject(store, (_instance, state) =>
		updateInstanceDomainBlock.run(state.storage.sql, { ...FIELDS, id, severity, now: NOW })
	)
	expect(updated?.severity).toBe(severity)
}

export async function unblockDomain(store: StoreStub, id: number): Promise<void> {
	const deleted = await runInDurableObject(store, (_instance, state) =>
		deleteInstanceDomainBlock.run(state.storage.sql, { id })
	)
	expect(deleted?.id).toBe(id)
}
