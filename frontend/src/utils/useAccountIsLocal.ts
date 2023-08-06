import { useSignal, useTask$ } from '@builder.io/qwik'
import { isLocalAccount } from 'wildebeest/backend/src/accounts'
import { parseHandle } from 'wildebeest/backend/src/utils/handle'
import { useDomain } from '~/utils/useDomain'

export function useAccountIsLocal(acct: string | undefined) {
	const domain = useDomain()
	const isLocal = useSignal(false)

	useTask$(({ track }) => {
		track(() => acct)

		if (acct) {
			const handle = parseHandle(acct)
			isLocal.value = isLocalAccount(domain, handle)
		}
	})

	return isLocal
}
