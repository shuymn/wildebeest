import { type Database } from 'wildebeest/backend/src/database'
import type { ContextData, MessageBody, Queue } from 'wildebeest/backend/src/types'
import { Nullable } from 'wildebeest/backend/src/utils/type'

export type Env = {
	DATABASE: Database
	// FIXME: shouldn't it be USER_KEY?
	userKEK: string
	QUEUE: Queue<MessageBody>
	DO_CACHE: DurableObjectNamespace
	DOMAIN: string

	CF_ACCOUNT_ID: string
	CF_API_TOKEN: string

	// Configuration for Cloudflare Access
	ACCESS_AUD: string
	ACCESS_AUTH_DOMAIN: string

	// Configuration for the instance
	INSTANCE_TITLE: string
	ADMIN_EMAIL: string
	INSTANCE_DESCR: string
	VAPID_JWK: string

	SENTRY_DSN: string
	SENTRY_ACCESS_CLIENT_ID: string
	SENTRY_ACCESS_CLIENT_SECRET: string
}

export type HonoEnv = {
	Bindings: Env & {
		ASSETS: {
			fetch: (req: Request) => Response
		}
		data: Nullable<Pick<ContextData, 'connectedActor'>> & Partial<Omit<ContextData, 'connectedActor'>>
	}
}
