import { $, component$ } from '@builder.io/qwik'
import { MastodonStatus } from '~/types'
import * as timelines from 'wildebeest/functions/api/v1/timelines/public'
import { DocumentHead, routeLoader$ } from '@builder.io/qwik-city'
import StickyHeader from '~/components/StickyHeader/StickyHeader'
import { getDocumentHead } from '~/utils/getDocumentHead'
import { StatusesPanel } from '~/components/StatusesPanel/StatusesPanel'
import { getErrorHtml } from '~/utils/getErrorHtml/getErrorHtml'
import { getDatabase } from 'wildebeest/backend/src/database'

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
		console.warn(error.stack, error.cause)
		throw html(500, getErrorHtml('The public timeline is unavailable'))
	}
})

export default component$(() => {
	const statuses = useStatuses()

	return (
		<>
			<StickyHeader>
				<div class="xl:rounded-t bg-wildebeest-700 p-4 flex items-center text-white">
					<i style={{ width: '1.25rem', height: '1rem' }} class="fa fa-globe fa-fw mr-3 w-5 h-4" />
					<span>Federated timeline</span>
				</div>
			</StickyHeader>
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
		</>
	)
})

export const useRequestUrl = routeLoader$(async ({ request }) => request.url)

export const head: DocumentHead = ({ resolveValue }) => {
	const url = resolveValue(useRequestUrl)
	return getDocumentHead({
		title: 'Federated timeline - Wildebeest',
		og: {
			url,
		},
	})
}
