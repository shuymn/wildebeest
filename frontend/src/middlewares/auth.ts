import { parse } from 'cookie'
import { Context, MiddlewareHandler } from 'hono'
import { generateValidator } from 'wildebeest/backend/src/access'
import { User, getUserByEmail } from 'wildebeest/backend/src/accounts'
import { getDatabase } from 'wildebeest/backend/src/database'
import { notAuthorized } from 'wildebeest/backend/src/errors'
import { HonoEnv } from 'wildebeest/backend/src/types'
import { getJwtEmail } from 'wildebeest/backend/src/utils/auth/getJwtEmail'

export const authMiddleware = (): MiddlewareHandler<HonoEnv> => {
	return async (c, next) => {
		const cookie = parse(c.req.raw.headers.get('Cookie') || '')
		const jwt = cookie['CF_Authorization']

		// initialize
		setConnectedActor(c, null)

		if (jwt) {
			const validate = generateValidator({
				jwt,
				domain: c.env.ACCESS_AUTH_DOMAIN,
				aud: c.env.ACCESS_AUD,
			})
			await validate(c.req.raw)

			let email = ''
			try {
				email = getJwtEmail(jwt ?? '')
			} catch (e) {
				return notAuthorized((e as Error)?.message)
			}

			const db = await getDatabase(c.env)
			const actor = await getUserByEmail(db, email)
			if (actor) {
				setConnectedActor(c, actor)
			}
		}
		await next()
	}
}

const setConnectedActor = (c: Context<HonoEnv>, user: User | null) => {
	c.env = {
		...c.env,
		data: {
			connectedActor: user,
		},
	}
}
