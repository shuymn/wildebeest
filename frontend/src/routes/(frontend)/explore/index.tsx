import { $, component$ } from '@builder.io/qwik'
import { getDatabase } from 'wildebeest/backend/src/database'
import { DocumentHead, routeLoader$ } from '@builder.io/qwik-city'
import * as timelines from 'wildebeest/functions/api/v1/timelines/public'
import { StatusesPanel } from '~/components/StatusesPanel/StatusesPanel'
import type { MastodonStatus } from '~/types'
import { getDocumentHead } from '~/utils/getDocumentHead'
import { getErrorHtml } from '~/utils/getErrorHtml/getErrorHtml'

export const useStatuses = routeLoader$(async ({ platform, html }): Promise<MastodonStatus[]> => {
	try {
		// TODO: use the "trending" API endpoint here.
		const response = await timelines.handleRequest(
			{ domain: platform.DOMAIN, db: await getDatabase(platform) },
			{
				local: false,
				remote: false,
				only_media: false,
				limit: 20,
			}
		)
		const results = await response.text()
		// Manually parse the JSON to ensure that Qwik finds the resulting objects serializable.
		return JSON.parse(results) as MastodonStatus[]
	} catch (e: unknown) {
		const error = e as { stack: string; cause: string }
		console.error(error.stack, error.cause)
		throw html(500, getErrorHtml('The timeline is unavailable, please try again later'))
	}
})

export default component$(() => {
	const statuses = useStatuses()
	return (
		<StatusesPanel
			initialStatuses={statuses.value}
			fetchMoreStatuses={$(async (maxId: string) => {
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
			})}
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
