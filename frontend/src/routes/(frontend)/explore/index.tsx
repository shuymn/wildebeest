import { component$ } from '@builder.io/qwik'
import { DocumentHead, routeLoader$ } from '@builder.io/qwik-city'
import { StatusesPanel } from '~/components/StatusesPanel/StatusesPanel'
import type { MastodonStatus } from '~/types'
import { fetchApi } from '~/utils/fetchApi'
import { getDocumentHead } from '~/utils/getDocumentHead'
import { getErrorHtml } from '~/utils/getErrorHtml/getErrorHtml'

export const useStatuses = routeLoader$(async ({ url, html, request }): Promise<MastodonStatus[]> => {
	try {
		// TODO: use the "trending" API endpoint here.
		const response = await fetchApi(request, url, `/api/v1/timelines/public`)
		if (!response.ok) {
			return []
		}
		const results = await response.text()
		// Manually parse the JSON to ensure that Qwik finds the resulting objects serializable.
		return JSON.parse(results) as MastodonStatus[]
	} catch (err) {
		if (err instanceof Error) {
			console.error(err.stack, err.cause)
		}
		throw html(500, getErrorHtml('The timeline is unavailable, please try again later'))
	}
})

export default component$(() => {
	const statuses = useStatuses()
	return (
		<StatusesPanel
			initialStatuses={statuses.value}
			fetchMoreStatuses$={async (maxId: string) => {
				let ss: MastodonStatus[] = []
				try {
					const response = await fetch(`/api/v1/timelines/public?max_id=${maxId}`)
					if (response.ok) {
						const results = await response.text()
						ss = JSON.parse(results)
					}
				} catch {
					/* empty */
				}
				return ss
			}}
		/>
	)
})

export const useRequestUrl = routeLoader$(async ({ request }) => request.url)

export const head: DocumentHead = ({ resolveValue }) => {
	const url = resolveValue(useRequestUrl)
	return getDocumentHead({
		title: 'Explore - Wildebeest',
		og: {
			url,
		},
	})
}
