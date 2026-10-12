import type { RequestEventCommon } from '@builder.io/qwik-city'
import { isAdminUser } from '@wildebeest/backend/accounts'
import { getDatabase } from '@wildebeest/backend/database'

/**
 * Rejects the request unless it comes from an authenticated instance administrator.
 *
 * It must be called by every admin route loader and action, the layout guard alone is not enough.
 */
export async function requireAdmin({ platform: { env }, error }: Pick<RequestEventCommon, 'platform' | 'error'>) {
	const user = env.data.connectedActor
	if (user === null) {
		throw error(401, 'Unauthorized')
	}
	if (!(await isAdminUser(getDatabase(env), env.ADMIN_EMAIL, user))) {
		throw error(403, 'Forbidden')
	}
}
