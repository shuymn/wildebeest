import { component$ } from '@builder.io/qwik'
import { MastodonStatus, StatusContext } from '~/types'
import Status from '~/components/Status'
import { DocumentHead, routeLoader$ } from '@builder.io/qwik-city'
import { getNotFoundHtml } from '~/utils/getNotFoundHtml/getNotFoundHtml'
import { getErrorHtml } from '~/utils/getErrorHtml/getErrorHtml'
import { getTextContent } from '@wildebeest/backend/activitypub/objects'
import { getDocumentHead } from '~/utils/getDocumentHead'
import { fetchApi } from '~/utils/fetchApi'

export const useStatus = routeLoader$(
	async ({
		url,
		html,
		params,
		request,
	}): Promise<{ status: MastodonStatus; statusTextContent: string; context: StatusContext }> => {
		let statusText = ''
		try {
			const statusResponse = await fetchApi(request, url, `/api/v1/statuses/${params.statusId}`)
			if (statusResponse.ok) {
				statusText = await statusResponse.text()
			}
		} catch (err) {
			if (err instanceof Error) {
				console.warn(err.stack, err.cause)
			} else {
				console.warn(err)
			}
			throw html(500, getErrorHtml('An error occurred whilst retrieving the status data, please try again later'))
		}
		if (!statusText) {
			throw html(404, getNotFoundHtml())
		}
		const status: MastodonStatus = JSON.parse(statusText)
		const statusTextContent = await getTextContent(status.content)

		try {
			const contextResponse = await fetch(`${url.origin}/api/v1/statuses/${params.statusId}/context`)
			const contextText = await contextResponse.text()
			const context = JSON.parse(contextText ?? null) as StatusContext | null
			if (!context) {
				throw new Error(`No context present for status with ${params.statusId}`)
			}
			return { status, statusTextContent, context }
		} catch (e: unknown) {
			const error = e as { stack: string; cause: string }
			console.warn(error.stack, error.cause)
			throw html(500, getErrorHtml('No context for the status has been found, please try again later'))
		}
	}
)

export default component$(() => {
	const status = useStatus()

	return (
		<>
			<Status status={status.value.status} accountSubText="acct" showInfoTray={true} contentClickable={false} />
			<div>
				{status.value.context.descendants.map((s) => {
					return <Status key={s.id} status={s} accountSubText="username" showInfoTray={false} contentClickable={true} />
				})}
			</div>
		</>
	)
})

export const head: DocumentHead = ({ resolveValue }) => {
	const { status, statusTextContent } = resolveValue(useStatus)

	const title = `${status.account.display_name}: ${statusTextContent.substring(0, 30)}${
		statusTextContent.length > 30 ? '…' : ''
	} - Wildebeest`

	return getDocumentHead({
		title,
		description: statusTextContent,
		og: {
			type: 'article',
			url: status.url,
			image: status.account.avatar,
		},
	})
}
