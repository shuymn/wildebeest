import { component$, Slot } from '@builder.io/qwik'
import type { RequestHandler } from '@builder.io/qwik-city'
import { requireAdmin } from '~/utils/requireAdmin'

// Rejects every request, including actions, to the admin settings routes from non admins.
// Each loader and action checks it again on its own.
export const onRequest: RequestHandler = async (requestEvent) => {
	await requireAdmin(requestEvent)
}

export default component$(() => {
	return (
		<>
			<Slot />
		</>
	)
})
