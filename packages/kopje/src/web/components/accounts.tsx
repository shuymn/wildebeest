import type { FC } from 'hono/jsx'

import { Pager } from './basics'
import { Who } from './post'
import { useUi } from '../ui'
import type { AuthorView } from '../view/account'
import type { PagerLinks } from '../view/pager'

// A list of accounts (design §11, `AccountRow`): a row each, its avatar, its name linked to its profile, and its
// address. The follow lists' members and the Featured tab's endorsed accounts.
export const AccountRows: FC<{ accounts: AuthorView[] }> = ({ accounts }) => (
	<ul class="card rows accounts" role="list">
		{accounts.map((account) => (
			<li>
				<Who account={account} size={44} />
			</li>
		))}
	</ul>
)

// A paged list of accounts, newest first (design §4): its rows, then its pager. An empty page that links on shows only
// its pager; `emptyText` shows only when no page lies either way. The follow lists and a status's Boosts and
// Favourites tabs.
export const AccountFeed: FC<{ accounts: AuthorView[]; emptyText: string; pager: PagerLinks }> = ({
	accounts,
	emptyText,
	pager,
}) => {
	const { m } = useUi()
	return (
		<>
			{accounts.length === 0 ? (
				pager.newer === null && pager.older === null ? (
					<p class="empty">{emptyText}</p>
				) : null
			) : (
				<AccountRows accounts={accounts} />
			)}
			<Pager
				label={m.a11y.pages}
				newer={pager.newer}
				older={pager.older}
				newerText={m.pager.newerFollows}
				olderText={m.pager.olderFollows}
			/>
		</>
	)
}
