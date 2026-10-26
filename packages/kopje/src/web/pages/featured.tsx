import type { FC } from 'hono/jsx'

import { featuredPath, profileTabs } from './profile'
import { tagPath } from './tag'
import type { Account } from '../../domain/accounts'
import type { FeaturedTagLink } from '../../domain/web-pages/featured'
import type { PageCursor, Paging } from '../../domain/web-pages/paging'
import type { Site } from '../../domain/web-pages/site'
import { AccountRows } from '../components/accounts'
import { Pager, Tabs } from '../components/basics'
import { FeaturedTags } from '../components/featured'
import { Layout } from '../components/layout'
import { ProfileCard } from '../components/profile'
import { plainText } from '../safe-html'
import { useUi } from '../ui'
import { accountView, authorView, displayName, followsPath } from '../view/account'
import { newestFirstPager } from '../view/pager'

export type FeaturedView = {
	account: Account
	tags: FeaturedTagLink[]
	// The endorsed accounts, by account id, newest first.
	accounts: Account[]
	cursor: PageCursor
	paging: Paging
	site: Site
}

// /@username/featured: the profile card and tabs, the account's featured hashtags, then the accounts it endorses,
// paged both ways (design §4).
export const FeaturedPage: FC<FeaturedView> = ({ account, tags, accounts, cursor, paging, site }) => {
	const { m } = useUi()
	const { domain } = site
	const base = featuredPath(account.username)
	// A page with a cursor names its cursor-less page as canonical, and is not indexed (design §4).
	const canonical = `https://${domain}${base}`
	const view = accountView(account, domain)
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
			<ProfileCard
				account={view}
				follows={{
					following: followsPath(account.username, 'following'),
					followers: followsPath(account.username, 'followers'),
				}}
			/>
			<Tabs label={m.a11y.profileSections} items={profileTabs(account.username, 'featured', m)} />
			<h2>{m.featured.hashtags}</h2>
			{tags.length === 0 ? (
				<p class="empty">{m.featured.noHashtags}</p>
			) : (
				<FeaturedTags
					tags={tags.map(({ featured, tag }) => ({
						name: featured.name,
						href: tag === null ? null : tagPath(tag),
						count: Number(featured.statuses_count),
					}))}
				/>
			)}
			<h2>{m.featured.accounts}</h2>
			{accounts.length === 0 ? (
				// An empty page that links on shows only its pager (design §4).
				pager.newer === null && pager.older === null ? (
					<p class="empty">{m.featured.noAccounts}</p>
				) : null
			) : (
				<AccountRows accounts={accounts.map((endorsed) => authorView(endorsed, domain))} />
			)}
			<Pager
				label={m.a11y.pages}
				newer={pager.newer}
				older={pager.older}
				newerText={m.featured.previous}
				olderText={m.featured.next}
			/>
		</Layout>
	)
}
