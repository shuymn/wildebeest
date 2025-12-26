import { component$ } from '@builder.io/qwik'
import { getDatabase } from '@wildebeest/backend/database'
import { routeLoader$ } from '@builder.io/qwik-city'
import { getErrorHtml } from '~/utils/getErrorHtml/getErrorHtml'
import type { MastodonStatus } from '~/types'
import { StatusesPanel } from '~/components/StatusesPanel/StatusesPanel'
import { parseHandle } from '@wildebeest/backend/utils/handle'
import { getMastodonIdByRemoteHandle } from '@wildebeest/backend/accounts/account'
import { getNotFoundHtml } from '~/utils/getNotFoundHtml/getNotFoundHtml'
import { fetchApi } from '~/utils/fetchApi'

export const useStatuses = routeLoader$(
	async ({
		platform: { env: platform },
		request,
		html,
		url,
	}): Promise<{
		mastodonId: string
		statuses: MastodonStatus[]
	}> => {
		let statuses: MastodonStatus[] = []
		let mastodonId: string | null = null
		try {
			const handle = parseHandle(url.pathname.split('/')[1])
			const db = getDatabase(platform)
			mastodonId = await getMastodonIdByRemoteHandle(db, {
				localPart: handle.localPart,
				domain: handle.domain ?? url.hostname,
			})
			if (mastodonId) {
				const response = await fetchApi(request, url, `/api/v1/accounts/${mastodonId}/statuses?exclude_replies=true`)
				if (response.ok) {
					statuses = await response.json<MastodonStatus[]>()
				}
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
	const statuses = useStatuses()

	return (
		<div data-testid="account-posts">
			<StatusesPanel
				initialStatuses={statuses.value.statuses}
				fetchMoreStatuses$={async (maxId: string) => {
					let ss: MastodonStatus[] = []
					try {
						const response = await fetch(
							`/api/v1/accounts/${statuses.value.mastodonId}/statuses?exclude_replies=true&max_id=${maxId}`
						)
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
		</div>
	)
})
