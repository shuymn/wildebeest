import * as actors from 'wildebeest/backend/src/activitypub/actors'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import type { DeliverMessageBody, InboxMessageBody, MessageBody } from 'wildebeest/backend/src/types'
import { MessageType } from 'wildebeest/backend/src/types'

import { handleDeliverMessage } from './deliver'
import { handleInboxMessage } from './inbox'
import { initSentryQueue } from './sentry'

export type Env = {
	DATABASE: Database
	DOMAIN: string
	ADMIN_EMAIL: string
	DO_CACHE: DurableObjectNamespace

	SENTRY_DSN: string
	SENTRY_ACCESS_CLIENT_ID: string
	SENTRY_ACCESS_CLIENT_SECRET: string
}

export default {
	async queue(batch: MessageBatch<MessageBody>, env: Env, ctx: ExecutionContext) {
		const sentry = initSentryQueue(env, ctx)
		const db = getDatabase(env)

		try {
			for (const message of batch.messages) {
				const actor = await actors.getActorById(db, new URL(message.body.actorId))
				if (actor === null) {
					console.warn(`actor ${message.body.actorId} is missing`)
					return
				}

				switch (message.body.type) {
					case MessageType.Inbox: {
						await handleInboxMessage(env, actor, message.body as InboxMessageBody)
						break
					}
					case MessageType.Deliver: {
						await handleDeliverMessage(env, actor, message.body as DeliverMessageBody)
						break
					}
					default:
						throw new Error(`unsupported message type: ${JSON.stringify(message.body)}`)
				}
			}
		} catch (err) {
			if (sentry !== null) {
				sentry.captureException(err)
			}
			if (err instanceof Error) {
				console.error(err.stack, err.cause)
			}
			throw err
		}
	},
}
