import type { FC } from 'hono/jsx'

import type { Account } from '../../domain/accounts'
import type { Status } from '../../domain/status-presenter'
import { Pager } from '../components/basics'
import { Layout } from '../components/layout'
import { PostCard } from '../components/post'
import { ProfileCard } from '../components/profile'
import { plainText } from '../safe-html'
import { useUi } from '../ui'
import { accountView, address, displayName } from '../view/account'
import { postView } from '../view/post'

export type ProfileView = {
	account: Account
	statuses: Status[]
	next: string | null
	domain: string
	actorUri: string
	// The hashtag the posts are of (/@username/tagged/:tag), or none for all of them.
	tag?: string | null
}

// /@username and /@username/tagged/:tag: the profile card, then the posts newest first, paged to older ones.
export const ProfilePage: FC<ProfileView> = ({ account, statuses, next, domain, actorUri, tag = null }) => {
	const { m } = useUi()
	const base = tag === null ? `/@${account.username}` : `/@${account.username}/tagged/${encodeURIComponent(tag)}`
	const view = accountView(account, domain)
	const title = m.profile.title(displayName(account), view.address)
	const description = plainText(account.note)
	return (
		<Layout
			title={title}
			chrome={{ domain, documents: null }}
			head={
				<>
					<meta name="description" content={description} />
					<meta property="og:site_name" content={domain} />
					<meta property="og:type" content="profile" />
					<meta property="og:title" content={title} />
					<meta property="og:description" content={description} />
					<meta property="og:url" content={account.url} />
					<meta property="og:image" content={view.avatar ?? undefined} />
					<meta property="profile:username" content={address(account, domain).slice(1)} />
					<link rel="canonical" href={account.url} />
					<link rel="alternate" type="application/activity+json" href={actorUri} />
				</>
			}
		>
			<ProfileCard account={view} />
			{tag === null ? null : <h2>#{tag}</h2>}
			{statuses.length === 0 ? (
				<p class="empty">{m.profile.noPosts}</p>
			) : (
				<ul class="feed" role="list">
					{statuses.map((status) => (
						<li>
							<PostCard post={postView(status, null, domain)} variant="feed" />
						</li>
					))}
				</ul>
			)}
			<Pager
				label={m.a11y.pages}
				newer={null}
				older={next === null ? null : `${base}?max_id=${next}`}
				newerText={m.pager.newer}
				olderText={m.pager.older}
			/>
		</Layout>
	)
}
