import { component$ } from '@builder.io/qwik'
import { routeLoader$ } from '@builder.io/qwik-city'

export const useRedirect = routeLoader$(({ redirect }) => {
	redirect(303, '/explore')
})

export default component$(() => {
	useRedirect()
	return <></>
})
