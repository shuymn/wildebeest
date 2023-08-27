import { $, component$, useSignal, type QRL, useVisibleTask$ } from '@builder.io/qwik'
import { type MastodonStatus } from '~/types'
import Status from '../Status'

type Props = {
	initialStatuses: MastodonStatus[]
	fetchMoreStatuses: QRL<(maxId: string) => Promise<MastodonStatus[]>>
}

export const StatusesPanel = component$(({ initialStatuses, fetchMoreStatuses: fetchMoreStatusesFn }: Props) => {
	const fetchingMoreStatuses = useSignal(false)
	const noMoreStatusesAvailable = useSignal(false)
	const lastStatusRef = useSignal<HTMLDivElement>()
	const statuses = useSignal<MastodonStatus[]>(initialStatuses)

	const fetchMoreStatuses = $(async () => {
		if (fetchingMoreStatuses.value || noMoreStatusesAvailable.value) {
			return
		}
		fetchingMoreStatuses.value = true
		const newStatuses =
			statuses.value.length === 0 ? [] : await fetchMoreStatusesFn(statuses.value[statuses.value.length - 1].id)
		fetchingMoreStatuses.value = false
		noMoreStatusesAvailable.value = newStatuses.length === 0
		statuses.value = [...statuses.value, ...newStatuses]
	})

	useVisibleTask$(({ track }) => {
		track(() => lastStatusRef.value)
		const ref = lastStatusRef.value
		if (ref) {
			const observer = new IntersectionObserver(
				async ([lastStatus]) => {
					if (lastStatus.isIntersecting) {
						await fetchMoreStatuses()
					}
				},
				{ rootMargin: '250px' }
			)
			observer.observe(ref)
			return () => observer.disconnect()
		}
	})

	return (
		<>
			{statuses.value.length > 0 ? (
				statuses.value.map((status, i) => {
					const isLastStatus = i === statuses.value.length - 1
					const divProps = isLastStatus ? { ref: lastStatusRef } : {}
					return (
						<div key={status.id} {...divProps}>
							<Status status={status} accountSubText="username" showInfoTray={false} contentClickable={true} />
						</div>
					)
				})
			) : (
				<div class="flex-1 grid place-items-center bg-wildebeest-600 text-center p-5 mt-8">
					<p>Nothing to see right now. Check back later!</p>
				</div>
			)}
		</>
	)
})
