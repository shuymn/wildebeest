import { User } from 'wildebeest/backend/src/accounts'

export type Identity = {
	email: string
}

export type ContextData = {
	// ActivityPub Person object of the logged in user
	connectedActor: User

	// Object returned by Cloudflare Access' provider
	identity: Identity

	// Client or app identifier
	clientId: string
}
