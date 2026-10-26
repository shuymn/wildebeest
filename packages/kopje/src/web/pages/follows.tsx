import type { FC } from 'hono/jsx'

import type { Account } from '../../domain/accounts'
import type { FollowDirection } from '../../domain/web-pages/follows'
import type { PageCursor, Paging } from '../../domain/web-pages/paging'
import type { Site } from '../../domain/web-pages/site'
import { Pager, Tabs } from '../components/basics'
import { Layout } from '../components/layout'
import { Who } from '../components/post'
import { useUi } from '../ui'
import { authorView, displayName, followsPath } from '../view/account'
import { emojiAllowance } from '../view/emoji'
import { newestFirstPager } from '../view/pager'

export type FollowsView = {
	account: Account
	direction: FollowDirection
	// The account hides its network: its counts and no list (R13).
	hidden: boolean
	accounts: Account[]
	cursor: PageCursor
	paging: Paging
	site: Site
}

// /@username/followers and /@username/following: the account, linked to its profile, the two lists as tabs with their
// counts, then the members newest follow first, paged both ways (design §4); the counts alone when the account hides
// them.
export const FollowsPage: FC<FollowsView> = ({ account, direction, hidden, accounts, cursor, paging, site }) => {
	const { m } = useUi()
	const { domain } = site
	const base = followsPath(account.username, direction)
	// A page with a cursor names its cursor-less page as canonical, and is not indexed (design §4).
	const canonical = `https://${domain}${base}`
	const allowance = emojiAllowance()
	const owner = authorView(account, domain, allowance)
	const title = (direction === 'followers' ? m.profile.followersTitle : m.profile.followingTitle)(
		displayName(account),
		owner.address
	)
	const tabs = (['following', 'followers'] as const).map((tab) => ({
		href: followsPath(account.username, tab),
		text:
			tab === 'following' ? m.counts.following(account.following_count) : m.counts.followers(account.followers_count),
		current: tab === direction,
	}))
	const pager = hidden ? { newer: null, older: null } : newestFirstPager(base, cursor, paging)
	return (
		<Layout
			title={title}
			chrome={site}
			head={
				<>
					{cursor === null ? null : <meta name="robots" content="noindex, follow" />}
					<link rel="canonical" href={canonical} />
				</>
			}
		>
			<Who account={owner} size={48} heading="h1" />
			<Tabs label={m.a11y.followLists} items={tabs} />
			{hidden ? null : accounts.length === 0 ? (
				// An empty page that links on shows only its pager (design §4).
				pager.newer === null && pager.older === null ? (
					<p class="empty">{direction === 'followers' ? m.profile.noFollowers : m.profile.noFollowing}</p>
				) : null
			) : (
				<ul class="card rows accounts" role="list">
					{accounts.map((member) => (
						<li>
							<Who account={authorView(member, domain, allowance)} size={44} />
						</li>
					))}
				</ul>
			)}
			<Pager
				label={m.a11y.pages}
				newer={pager.newer}
				older={pager.older}
				newerText={m.pager.newerFollows}
				olderText={m.pager.olderFollows}
			/>
		</Layout>
	)
}
