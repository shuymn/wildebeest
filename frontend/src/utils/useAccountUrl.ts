import { Account } from '~/types'
import { useAccountIsLocal } from '~/utils/useAccountIsLocal'

/**
 * Hook to get a url to use for links for the provided account.
 *
 * Note: using account.url is not sufficient since we want to distinguish
 *       between local and remote accounts and change the url accordingly
 *
 * @param account the target account or null
 * @returns url to be used for the target account (or undefined if)
 */
export function useAccountUrl(account: Pick<Account, 'acct' | 'url'>): string {
	const { value: isLocal } = useAccountIsLocal(account.acct)
	if (isLocal) {
		const url = new URL(account.url)
		return url.pathname
	}
	return account.url
}
