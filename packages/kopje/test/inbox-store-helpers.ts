import { runInDurableObject } from 'cloudflare:test'

import { NOW } from './app-helpers'
import { BUILD } from './helpers'
import { LOCAL } from './inbox-helpers'
import { Db } from '../src/db/sql'
import type { InboundActivity, ReceiveResult } from '../src/domain/inbox'
import type { StoreStub } from '../src/platform/store-client'

// An activity of the remote actor `actorUri` through the Store's receive, as the Worker passes it once it has verified
// and parsed it, with the actor's stored row (no document); `now` is the Worker's clock (the Store adds its own).
export function storeReceive(
	store: StoreStub,
	actorUri: string,
	activity: InboundActivity,
	now = NOW
): Promise<ReceiveResult> {
	return store.receiveActivity(BUILD, { now, origin: LOCAL, actorUri, actor: null, activity })
}

// Runs `step` in one Store transaction: what it returned, and the rows it wrote (SQLite's total_changes()).
export function writtenBy<T>(store: StoreStub, step: (db: Db) => T): Promise<{ result: T; rows: number }> {
	return runInDurableObject(store, (_instance, state) => {
		const db = new Db(state.storage.sql)
		const changes = () => db.first<{ n: number }>('SELECT total_changes() AS n')!.n
		const before = changes()
		const result = state.storage.transactionSync(() => step(db))
		return { result, rows: changes() - before }
	})
}
