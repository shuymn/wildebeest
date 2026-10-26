import type { FC } from 'hono/jsx'

import type { Account } from '../../domain/accounts'
import type { Status } from '../../domain/status-presenter'
import type { StatusStub } from '../../domain/web-pages/budget'
import type { ParentLink } from '../../domain/web-pages/parents'
import type { Site } from '../../domain/web-pages/site'
import { Pager } from '../components/basics'
import { Layout } from '../components/layout'
import { PostCard, PostStub } from '../components/post'
import { ProfileCard } from '../components/profile'
import { plainText } from '../safe-html'
import { useUi } from '../ui'
import { accountView, address, displayName } from '../view/account'
import { postView, stubView } from '../view/post'

export type ProfileView = {
	account: Account
	statuses: Status[]
	// The first post when it was too large to show here (design §2).
	stub: StatusStub | null
	// The parents the anonymous viewer may see, by id.
	parents: Record<string, ParentLink>
	next: string | null
	site: Site
	actorUri: string
	// The hashtag the posts are of (/@username/tagged/:tag), or none for all of them.
	tag?: string | null
}

// /@username and /@username/tagged/:tag: the profile card, then the posts newest first, paged to older ones.
export const ProfilePage: FC<ProfileView> = ({
	account,
	statuses,
	stub,
	parents,
	next,
	site,
	actorUri,
	tag = null,
}) => {
	const { m } = useUi()
	const { domain } = site
	const base = tag === null ? `/@${account.username}` : `/@${account.username}/tagged/${encodeURIComponent(tag)}`
	const view = accountView(account, domain)
	const title = m.profile.title(displayName(account), view.address)
	const description = plainText(account.note)
	return (
		<Layout
			title={title}
			chrome={site}
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
			{statuses.length === 0 && stub === null ? (
				// An empty page that links on shows only its pager (design §4).
				next !== null ? null : (
					<p class="empty">{m.profile.noPosts}</p>
				)
			) : (
				<ul class="feed" role="list">
					{stub === null ? null : (
						<li>
							<PostStub stub={stubView(stub, domain)} />
						</li>
					)}
					{statuses.map((status) => (
						<li>
							<PostCard post={postView(status, parentOf(parents, status.in_reply_to_id), domain)} variant="feed" />
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

function parentOf(parents: Record<string, ParentLink>, id: string | null): ParentLink | null {
	return id === null ? null : (parents[id] ?? null)
}
