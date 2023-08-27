import { component$ } from '@builder.io/qwik'
import { DocumentHead, routeLoader$ } from '@builder.io/qwik-city'
import { getDatabase } from 'wildebeest/backend/src/database'
import { getDomain } from 'wildebeest/backend/src/utils/getDomain'
import { handleRequest } from 'wildebeest/backend/src/routes/api/v1/timelines/tag/[tag]'
import { StatusesPanel } from '~/components/StatusesPanel/StatusesPanel'
import StickyHeader from '~/components/StickyHeader/StickyHeader'
import { MastodonStatus } from '~/types'
import { getDocumentHead } from '~/utils/getDocumentHead'

export const useTimelinesTag = routeLoader$(
	async ({ request, platform: { env: platform }, params }): Promise<{ tag: string; statuses: MastodonStatus[] }> => {
		const tag = params.tag
		const response = await handleRequest(await getDatabase(platform), request, getDomain(request.url), tag)
		const results = await response.text()
		const statuses: MastodonStatus[] = JSON.parse(results)
		return { tag, statuses }
	}
)

export default component$(() => {
	const loaderData = useTimelinesTag()

	return (
		<>
			<div class="flex flex-col flex-1">
				<StickyHeader withBackButton backButtonPlacement="end">
					<h2 class="text-reg text-md m-0 p-4 flex bg-wildebeest-700">
						<i class="fa fa-hashtag fa-fw mr-3 w-5 leading-tight inline-block" />
						<span>{loaderData.value.tag}</span>
					</h2>
				</StickyHeader>
				<StatusesPanel
					initialStatuses={loaderData.value.statuses}
					fetchMoreStatuses$={async (maxId: string) => {
						let statuses: MastodonStatus[] = []
						try {
							// FIXME: this endpoint does not have max_id parameter
							const response = await fetch(`/api/v1/timelines/tag/${loaderData.value.tag}?max_id=${maxId}`)
							if (response.ok) {
								const results = await response.text()
								statuses = JSON.parse(results)
							}
						} catch {
							/* empty */
						}
						return statuses
					}}
				/>
			</div>
		</>
	)
})

export const useRequestUrl = routeLoader$(async ({ request }) => request.url)

export const head: DocumentHead = ({ resolveValue }) => {
	const { tag } = resolveValue(useTimelinesTag)
	const url = resolveValue(useRequestUrl)

	return getDocumentHead({
		title: `#${tag} - Wildebeest`,
		description: `#${tag} tag page - Wildebeest`,
		og: {
			url,
		},
	})
}
