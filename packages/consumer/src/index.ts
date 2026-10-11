import * as actors from '@wildebeest/backend/activitypub/actors'
import { type Database, getDatabase } from '@wildebeest/backend/database'
import type { DeliverMessageBody, InboxMessageBody, MessageBody } from '@wildebeest/backend/types'
import { MessageType } from '@wildebeest/backend/types'

import { handleDeliverMessage } from './deliver'
import { handleInboxMessage, isSignedInboxMessage } from './inbox'
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

		for (const message of batch.messages) {
			try {
				const actor = await actors.getActorById(db, new URL(message.body.actorId))
				if (actor === null) {
					console.warn(`actor ${message.body.actorId} is missing`)
					message.ack()
					continue
				}

				switch (message.body.type) {
					case MessageType.Inbox: {
						const inbox = message.body as InboxMessageBody
						if (!isSignedInboxMessage(inbox)) {
							console.warn(`dropping unauthenticated Inbox message ${String(inbox.activity?.id)}`)
							break
						}
						await handleInboxMessage(env, actor, inbox)
						break
					}
					case MessageType.Deliver: {
						await handleDeliverMessage(env, actor, message.body as DeliverMessageBody)
						break
					}
					default:
						throw new Error(`unsupported message type: ${String(message.body.type)}`)
				}
				message.ack()
			} catch (err) {
				if (sentry !== null) {
					sentry.captureException(err)
				}
				if (err instanceof Error) {
					console.error(err.stack, err.cause)
				}
				message.retry()
			}
		}
	},
}
