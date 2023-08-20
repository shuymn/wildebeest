import { Context, MiddlewareHandler, Next } from 'hono'

import { generateValidator, getIdentity, getPayload } from 'wildebeest/backend/src/access'
import { getUserByEmail } from 'wildebeest/backend/src/accounts'
import { getDatabase } from 'wildebeest/backend/src/database'
import { notAuthorized } from 'wildebeest/backend/src/errors'
import { HonoEnv } from 'wildebeest/backend/src/types'

export const publicMiddleware = (): MiddlewareHandler<HonoEnv> => {
	return async (c, next) => {
		const authorization = c.req.raw.headers.get('Authorization') || ''
		const token = authorization.replace('Bearer ', '')
		if (token === '') {
			return next()
		}
		return authorize(c, next, token)
	}
}

export const privateMiddleware = (): MiddlewareHandler<HonoEnv> => {
	return async (c, next) => {
		const authorization = c.req.raw.headers.get('Authorization') || ''
		const token = authorization.replace('Bearer ', '')
		if (token === '') {
			return notAuthorized('missing authorization')
		}
		return authorize(c, next, token)
	}
}

const authorize = async (c: Context<HonoEnv>, next: Next, token: string) => {
	const parts = token.split('.')
	if (parts.length !== 4) {
		return notAuthorized(`invalid token. expected 4 parts, got ${parts.length}`)
	}
	const [clientId, ...jwtParts] = parts
	const jwt = jwtParts.join('.')

	try {
		const { email } = getPayload(jwt)
		if (!email) {
			return notAuthorized('missing email')
		}

		// Load the user associated with the email in the payload *before*
		// verifying the JWT validity.
		// This is because loading the context will also load the access
		// configuration, which are used to verify the JWT.
		// TODO: since we don't load the instance configuration anymore, we
		// don't need to load the user before anymore.
		const db = await getDatabase(c.env)
		const actor = await getUserByEmail(db, email)
		if (actor === null) {
			console.warn('person not found')
			return notAuthorized('failed to load context data')
		}

		c.env = {
			...c.env,
			data: {
				connectedActor: actor,
				identity: { email },
				clientId,
			},
		}

		const validate = generateValidator({
			jwt,
			domain: c.env.ACCESS_AUTH_DOMAIN,
			aud: c.env.ACCESS_AUD,
		})
		await validate(c.req.raw)

		const identity = await getIdentity({ jwt, domain: c.env.ACCESS_AUTH_DOMAIN })
		if (!identity) {
			return notAuthorized('failed to load identity')
		}

		return next()
	} catch (err) {
		if (err instanceof Error) {
			console.warn(err.stack)
		}
		return notAuthorized('unknown error occurred')
	}
}
