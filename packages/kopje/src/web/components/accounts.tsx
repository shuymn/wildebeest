import type { FC } from 'hono/jsx'

import { Who } from './post'
import type { AuthorView } from '../view/account'

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
