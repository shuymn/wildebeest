import { $, component$, useStyles$ } from '@builder.io/qwik'
import { routeLoader$ } from '@builder.io/qwik-city'
import styles from '../../../../utils/innerHtmlContent.scss?inline'
import { getErrorHtml } from '~/utils/getErrorHtml/getErrorHtml'
import type { MastodonStatus } from '~/types'
import { StatusesPanel } from '~/components/StatusesPanel/StatusesPanel'
import { handleRequest } from 'wildebeest/backend/src/routes/api/v1/accounts/[id]/statuses'
import { getDatabase } from 'wildebeest/backend/src/database'
import { getMastodonIdByRemoteHandle } from 'wildebeest/backend/src/accounts/account'
import { parseHandle } from 'wildebeest/backend/src/utils/handle'
import { getNotFoundHtml } from '~/utils/getNotFoundHtml/getNotFoundHtml'

export const useStatuses = routeLoader$(
	async ({
		platform: { env: platform },
		request,
		html,
	}): Promise<{
		mastodonId: string
		statuses: MastodonStatus[]
	}> => {
		let statuses: MastodonStatus[] = []
		let mastodonId: string | null = ''
		try {
			const url = new URL(request.url)
			const handle = parseHandle(url.pathname.split('/')[1])
			const db = await getDatabase(platform)
			mastodonId = await getMastodonIdByRemoteHandle(db, {
				localPart: handle.localPart,
				domain: handle.domain ?? url.hostname,
			})
			if (mastodonId) {
				const response = await handleRequest(
					{ domain: url.hostname, db: await getDatabase(platform), connectedActor: undefined },
					mastodonId,
					{
						// default values
						limit: 20,
						only_media: false,
						exclude_replies: false,
						exclude_reblogs: false,
						pinned: false,
					}
				)
				statuses = await response.json<Array<MastodonStatus>>()
			}
		} catch {
			throw html(
				500,
				getErrorHtml(`An error happened when trying to retrieve the account's statuses, please try again later`)
			)
		}

		if (mastodonId === null) {
			throw html(404, getNotFoundHtml())
		}

		return { mastodonId, statuses: JSON.parse(JSON.stringify(statuses)) }
	}
)

export default component$(() => {
	useStyles$(styles)

	const statuses = useStatuses()

	return (
		<div data-testid="account-posts-and-replies">
			<StatusesPanel
				initialStatuses={statuses.value.statuses}
				fetchMoreStatuses={$(async (maxId: string) => {
					let ss: MastodonStatus[] = []
					try {
						const response = await fetch(`/api/v1/accounts/${statuses.value.mastodonId}/statuses?max_id=${maxId}`)
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
		</div>
	)
})
