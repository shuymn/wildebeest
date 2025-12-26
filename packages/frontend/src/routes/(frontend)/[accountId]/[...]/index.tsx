import { component$ } from '@builder.io/qwik'
import { routeLoader$ } from '@builder.io/qwik-city'
import { getNotFoundHtml } from '~/utils/getNotFoundHtml/getNotFoundHtml'

export const useRedirect = routeLoader$(({ html }) => {
	html(404, getNotFoundHtml())
})

export default component$(() => {
	useRedirect()
	return <></>
})
