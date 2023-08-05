/*
 * WHAT IS THIS FILE?
 *
 * It's the  entry point for cloudflare-pages when building for production.
 *
 * Learn more about the cloudflare integration here:
 * - https://qwik.builder.io/integrations/deployments/cloudflare-pages/#cloudflare-pages-entry-middleware
 *
 */
import { createQwikCity } from '@builder.io/qwik-city/middleware/cloudflare-pages'
import qwikCityPlan from '@qwik-city-plan'
import render from './entry.ssr'
import type { Env, ContextData } from 'wildebeest/backend/src/types'
import { parse } from 'cookie'
import * as access from 'wildebeest/backend/src/access'
import { getJwtEmail } from 'wildebeest/backend/src/utils/auth/getJwtEmail'
import * as errors from 'wildebeest/backend/src/errors'
import { getDatabase } from 'wildebeest/backend/src/database'
import { User, getUserByEmail } from 'wildebeest/backend/src/accounts'

const qwikHandler = createQwikCity({ render, qwikCityPlan })

type QwikContextData = {
	connectedActor: User | null
}

// eslint-disable-next-line
export const onRequest: PagesFunction<Env, any, ContextData> = async (ctx) => {
	const cookie = parse(ctx.request.headers.get('Cookie') || '')
	const jwt = cookie['CF_Authorization']

	const data: QwikContextData = {
		connectedActor: null,
	}

	if (jwt) {
		const validate = access.generateValidator({
			jwt,
			domain: ctx.env.ACCESS_AUTH_DOMAIN,
			aud: ctx.env.ACCESS_AUD,
		})
		await validate(ctx.request)

		let email = ''
		try {
			email = getJwtEmail(jwt ?? '')
		} catch (e) {
			return errors.notAuthorized((e as Error)?.message)
		}

		const db = await getDatabase(ctx.env)
		data.connectedActor = await getUserByEmail(db, email)
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	ctx.env = { ...ctx.env, data } as any

	return qwikHandler(ctx)
}
