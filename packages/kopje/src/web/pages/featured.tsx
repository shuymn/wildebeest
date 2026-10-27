import type { FC } from 'hono/jsx'

import { featuredPath, profileTabs } from './profile'
import { tagPath } from './tag'
import type { Account } from '../../domain/accounts'
import type { FeaturedTagLink } from '../../domain/web-pages/featured'
import type { PageCursor, Paging } from '../../domain/web-pages/paging'
import type { Site } from '../../domain/web-pages/site'
import { AccountFeed } from '../components/accounts'
import { Tabs } from '../components/basics'
import { FeaturedTags } from '../components/featured'
import { Layout } from '../components/layout'
import { ProfileHead } from '../components/profile'
import { plainText } from '../safe-html'
import { useUi } from '../ui'
import { accountView, authorView, displayName } from '../view/account'
import { emojiAllowance } from '../view/emoji'
import { newestFirstPager } from '../view/pager'
import { accountTarget } from '../view/remote'

export type FeaturedView = {
	account: Account
	tags: FeaturedTagLink[]
	// The endorsed accounts, by account id, newest first.
	accounts: Account[]
	cursor: PageCursor
	paging: Paging
	site: Site
}

// /@username/featured: the profile's head and tabs, the account's featured hashtags, then the accounts it endorses,
// paged both ways.
export const FeaturedPage: FC<FeaturedView> = ({ account, tags, accounts, cursor, paging, site }) => {
	const { m } = useUi()
	const { domain } = site
	const base = featuredPath(account.username)
	// A page with a cursor names its cursor-less page as canonical, and is not indexed.
	const canonical = `https://${domain}${base}`
	// The page's emoji allowance, spent in document order: the profile card, then the endorsed accounts.
	const allowance = emojiAllowance()
	const view = accountView(account, domain, allowance)
	// The follow dialog's title, charged after the card and before the endorsed accounts, as the page orders them.
	const followTarget = accountTarget(account, domain, allowance)
	const pager = newestFirstPager(base, cursor, paging)
	return (
		<Layout
			title={m.profile.title(displayName(account), view.address)}
			chrome={site}
			head={
				<>
					<meta name="description" content={plainText(account.note)} />
					{cursor === null ? null : <meta name="robots" content="noindex, follow" />}
					<link rel="canonical" href={canonical} />
				</>
			}
		>
			<ProfileHead account={account} view={view} target={followTarget} />
			<Tabs label={m.a11y.profileSections} items={profileTabs(account.username, 'featured', m)} />
			<div class="sections">
				<section class="stack">
					<h2>{m.featured.hashtags}</h2>
					{tags.length === 0 ? (
						<p class="muted">{m.featured.noHashtags}</p>
					) : (
						<FeaturedTags
							tags={tags.map(({ featured, tag }) => ({
								name: featured.name,
								href: tag === null ? null : tagPath(tag),
								count: Number(featured.statuses_count),
							}))}
						/>
					)}
				</section>
				<section class="stack">
					<h2>{m.featured.accounts}</h2>
					<AccountFeed
						accounts={accounts.map((endorsed) => authorView(endorsed, domain, allowance))}
						emptyText={m.featured.noAccounts}
						pager={pager}
					/>
				</section>
			</div>
		</Layout>
	)
}
