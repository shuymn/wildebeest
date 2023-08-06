import { MastodonStatus } from '~/types'
import { useAccountIsLocal } from '~/utils/useAccountIsLocal'

export function useStatusUrl(status: Pick<MastodonStatus, 'url' | 'account'>): string {
	const { value: isLocal } = useAccountIsLocal(status.account.acct)
	if (isLocal) {
		const url = new URL(status.url)
		return url.pathname
	}
	return status.url
}
