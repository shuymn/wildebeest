import type { FC } from 'hono/jsx'

import type { Account } from '../../domain/accounts'
import type { Status } from '../../domain/status-presenter'
import type { StatusStub } from '../../domain/web-pages/budget'
import type { PageCursor, Paging } from '../../domain/web-pages/paging'
import type { ParentLink } from '../../domain/web-pages/parents'
import type { ProfileTab } from '../../domain/web-pages/profile'
import type { Site } from '../../domain/web-pages/site'
import { Tabs } from '../components/basics'
import { Layout } from '../components/layout'
import { InlineText, PostCard, PostFeed, PostStub } from '../components/post'
import { ProfileCard } from '../components/profile'
import { plainText } from '../safe-html'
import { useUi } from '../ui'
import { accountView, address, displayName, followsPath } from '../view/account'
import { emojiAllowance, emojiField } from '../view/emoji'
import { newestFirstPager } from '../view/pager'
import { postView, stubView } from '../view/post'

export type ProfileView = {
	account: Account
	tab: ProfileTab
	// The Posts tab's first page: the pinned posts, shown before the list.
	pins: Status[]
	statuses: Status[]
	// The first post when it was too large to show here (design §2).
	stub: StatusStub | null
	// The parents the anonymous viewer may see, by id.
	parents: Record<string, ParentLink>
	cursor: PageCursor
	paging: Paging
	site: Site
	actorUri: string
}

// The cursor-less path of a profile tab.
function tabPath(username: string, tab: ProfileTab): string {
	const profile = `/@${username}`
	switch (tab.kind) {
		case 'posts':
			return profile
		case 'with_replies':
			return `${profile}/with_replies`
		case 'media':
			return `${profile}/media`
		case 'tagged':
			return `${profile}/tagged/${encodeURIComponent(tab.tag)}`
	}
}

// /@username and its tabs: the profile card, the tabs, then the posts newest first, paged both ways (design §4).
export const ProfilePage: FC<ProfileView> = ({
	account,
	tab,
	pins,
	statuses,
	stub,
	parents,
	cursor,
	paging,
	site,
	actorUri,
}) => {
	const { m } = useUi()
	const { domain } = site
	const base = tabPath(account.username, tab)
	// A page with a cursor names its cursor-less page as canonical, and is not indexed (design §4).
	const canonical = `https://${domain}${base}`
	// The page's emoji allowance, spent in document order: the profile card, then the posts.
	const allowance = emojiAllowance()
	const view = accountView(account, domain, allowance)
	const title = m.profile.title(displayName(account), view.address)
	const description = plainText(account.note)
	const pager = newestFirstPager(base, cursor, paging)
	const tabs = (['posts', 'with_replies', 'media'] as const).map((kind) => ({
		href: tabPath(account.username, { kind }),
		text: { posts: m.profile.posts, with_replies: m.profile.postsAndReplies, media: m.profile.media }[kind],
		current: tab.kind === kind,
	}))
	const card = (status: Status, label?: { icon: 'pin' | 'boost'; text: string }) => {
		// A boost shows its original under the booster's label (VIS-6: the read admits it only with its original), the
		// booster's name with its emoji, charged to the allowance before the post it labels.
		const shown = status.reblog ?? status
		const booster =
			status.reblog === null ? null : emojiField(status.account.emojis, allowance).text(displayName(status.account))
		return (
			<li>
				<PostCard
					post={postView(shown, parentOf(parents, shown.in_reply_to_id), domain, allowance)}
					variant="feed"
					label={booster === null ? label : { icon: 'boost', text: m.post.boosted(<InlineText text={booster} />) }}
				/>
			</li>
		)
	}
	const empty = pins.length === 0 && statuses.length === 0 && stub === null
	return (
		<Layout
			title={title}
			chrome={site}
			head={
				<>
					<meta name="description" content={description} />
					{cursor === null ? null : <meta name="robots" content="noindex, follow" />}
					<meta property="og:site_name" content={domain} />
					<meta property="og:type" content="profile" />
					<meta property="og:title" content={title} />
					<meta property="og:description" content={description} />
					<meta property="og:url" content={canonical} />
					<meta property="og:image" content={view.avatar ?? undefined} />
					<meta property="profile:username" content={address(account, domain).slice(1)} />
					<link rel="canonical" href={canonical} />
					<link rel="alternate" type="application/activity+json" href={actorUri} />
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
			<Tabs label={m.a11y.profileSections} items={tabs} />
			{tab.kind === 'tagged' ? <h2>#{tab.tag}</h2> : null}
			<PostFeed empty={empty} emptyText={m.profile.noPosts} pager={pager}>
				{pins.map((status) => card(status, { icon: 'pin', text: m.post.pinned }))}
				{stub === null ? null : (
					<li>
						<PostStub stub={stubView(stub, domain)} />
					</li>
				)}
				{statuses.map((status) => card(status))}
			</PostFeed>
		</Layout>
	)
}

function parentOf(parents: Record<string, ParentLink>, id: string | null): ParentLink | null {
	return id === null ? null : (parents[id] ?? null)
}
