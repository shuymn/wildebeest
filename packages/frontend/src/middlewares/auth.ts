import { parse } from 'cookie'
import { Context, MiddlewareHandler } from 'hono'
import { generateValidator } from '@wildebeest/backend/access'
import { User, getUserByEmail } from '@wildebeest/backend/accounts'
import { getDatabase } from '@wildebeest/backend/database'
import { notAuthorized } from '@wildebeest/backend/errors'
import { HonoEnv } from '@wildebeest/backend/types'
import { getJwtEmail } from '@wildebeest/backend/utils/auth/getJwtEmail'

export const authMiddleware = (): MiddlewareHandler<HonoEnv> => {
	return async (c, next) => {
		const cookie = parse(c.req.header('Cookie') || '')
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

			const db = getDatabase(c.env)
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
