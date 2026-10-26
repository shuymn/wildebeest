import type { Child, FC } from 'hono/jsx'

import { DateTime, LinkTo, Rich, VisuallyHidden } from './basics'
import { Icon } from './icon'
import type { IconName } from '../icons'
import { useUi } from '../ui'
import type { AuthorView, Inline } from '../view/account'
import type { Link } from '../view/link'
import type { MediaView } from '../view/media'
import type { CountKind, CountView, PostView, StubView } from '../view/post'

// Accounts and posts (design §11). Avatars are decorative; their boxes match their CSS size (§13).

type AvatarSize = 40 | 44 | 48 | 88

export const Avatar: FC<{ src: string | null; size: AvatarSize; eager?: boolean }> = ({ src, size, eager = false }) =>
	src === null ? (
		<span class={`av av${size}`} aria-hidden="true" />
	) : (
		<img
			class={`av av${size}`}
			src={src}
			alt=""
			width={size}
			height={size}
			loading={eager ? undefined : 'lazy'}
			decoding="async"
		/>
	)

export const InlineText: FC<{ text: Inline[] }> = ({ text }) => <>{text.join('')}</>

// An account's name, address and, for a post, its date (a link to the post when it has one).
export const Who: FC<{
	account: AuthorView
	size: 40 | 44 | 48
	heading?: 'h1'
	when?: { iso: string; text: string; link: Link | null; edited: boolean }
}> = ({ account, size, heading, when }) => {
	const { m } = useUi()
	const name = <InlineText text={account.name} />
	const date = when === undefined ? null : <DateTime iso={when.iso} text={when.text} local />
	return (
		<div class="who">
			{/* The focal post's author avatar is above the fold: eager (amendment A7). */}
			<Avatar src={account.avatar} size={size} eager={heading === 'h1'} />
			<div class="id">
				{heading === 'h1' ? (
					<h1 class="name">{account.link === null ? name : <LinkTo link={account.link}>{name}</LinkTo>}</h1>
				) : account.link === null ? (
					<span class="name">{name}</span>
				) : (
					<LinkTo class="name" link={account.link}>
						{name}
					</LinkTo>
				)}
				<p class="meta">
					<span class="handle">{account.address}</span>
					{when === undefined ? null : (
						<>
							{' · '}
							{when.link === null ? date : <LinkTo link={when.link}>{date}</LinkTo>}
							{when.edited ? (
								<>
									{' · '}
									{m.post.edited}
								</>
							) : null}
						</>
					)}
				</p>
			</div>
		</div>
	)
}

// The state cue of a summary: Show while closed, Hide while open (the stylesheet hides the other).
const Disclosure: FC = () => {
	const { m } = useUi()
	return (
		<>
			<span class="show">{m.post.show}</span>
			<span class="hide">{m.post.hide}</span>
		</>
	)
}

export const ContentWarning: FC<{ text: Inline[]; lang?: string; children?: Child }> = ({ text, lang, children }) => {
	return (
		<details class="cw">
			<summary>
				<span class="spoiler" lang={lang}>
					<Icon name="cw" size={16} decorative />
					<InlineText text={text} />
				</span>
				<Disclosure />
			</summary>
			{children}
		</details>
	)
}

// The media of a post. `lcp`: its first image is the page's likely largest paint, loaded first (§13); every other
// image is lazy.
export const MediaGrid: FC<{ items: MediaView[]; sensitive: boolean; lcp: boolean }> = ({ items, sensitive, lcp }) => {
	const { m } = useUi()
	if (items.length === 0) {
		return null
	}
	const grid = (
		<div class="media-grid">
			{items.map((item, index) => {
				const first = lcp && !sensitive && index === 0
				return (
					<a class="media-item" href={item.full}>
						<img
							class={item.width === undefined ? 'box' : undefined}
							src={item.preview}
							alt={item.alt}
							width={item.width}
							height={item.height}
							loading={first ? undefined : 'lazy'}
							fetchpriority={first ? 'high' : undefined}
							decoding="async"
						/>
						{item.alt === '' ? <span>{m.media.noDescription}</span> : null}
					</a>
				)
			})}
		</div>
	)
	return sensitive ? (
		<details class="sensitive">
			<summary>
				<span>{m.post.sensitiveMedia}</span>
				<Disclosure />
			</summary>
			{grid}
		</details>
	) : (
		grid
	)
}

export const PostBody: FC<{ post: PostView; lcp: boolean }> = ({ post, lcp }) => {
	const content = (
		<>
			<Rich class="body" html={post.html} lang={post.lang} />
			<MediaGrid items={post.media} sensitive={post.sensitive} lcp={lcp && post.cw.length === 0} />
		</>
	)
	// The content warning hides the content until the reader opens it, with no script.
	return post.cw.length === 0 ? (
		content
	) : (
		<ContentWarning text={post.cw} lang={post.lang}>
			{content}
		</ContentWarning>
	)
}

const COUNT_ICONS: Record<CountKind, IconName> = {
	replies: 'reply',
	boosts: 'boost',
	favourites: 'fav',
	quotes: 'quote',
}

// A linked count is named by its label, which contains the visible number; an unlinked one shows the number to sight
// and the label to assistive technology (§14.6).
export const Counts: FC<{ items: CountView[] }> = ({ items }) => {
	const { m, f } = useUi()
	return (
		<div class="counts">
			{items.map((item) => {
				const label = m.counts[item.kind](item.n)
				const icon = <Icon name={COUNT_ICONS[item.kind]} size={18} decorative />
				return item.href === undefined ? (
					<span>
						{icon}
						<span aria-hidden="true">{f.count(item.n)}</span>
						<VisuallyHidden>{label}</VisuallyHidden>
					</span>
				) : (
					<a href={item.href} aria-label={label}>
						{icon}
						{f.count(item.n)}
					</a>
				)
			})}
		</div>
	)
}

export const PostCard: FC<{
	post: PostView
	variant: 'feed' | 'focal' | 'embed'
	label?: { icon: IconName; text: string }
}> = ({ post, variant, label }) => {
	const { m, f } = useUi()
	const focal = variant === 'focal'
	const edited = post.editedAt !== null
	return (
		<article class={focal ? 'card post focal' : 'card post'}>
			{label === undefined ? null : (
				<p class="label">
					<Icon name={label.icon} size={16} decorative />
					{label.text}
				</p>
			)}
			<Who
				account={post.author}
				size={focal ? 48 : 44}
				heading={focal ? 'h1' : undefined}
				when={focal ? undefined : { iso: post.createdAt, text: f.instant(post.createdAt), link: post.link, edited }}
			/>
			{post.replyTo === null ? null : (
				<p class="reply-to">
					<Icon name="reply" size={16} decorative />
					{m.post.inReplyTo} <LinkTo link={post.replyTo.link}>@{post.replyTo.acct}</LinkTo>
				</p>
			)}
			<PostBody post={post} lcp={focal} />
			{focal ? (
				<p class="meta">
					<DateTime iso={post.createdAt} text={f.instant(post.createdAt)} local />
					{edited ? (
						<>
							{' · '}
							{m.post.edited}
						</>
					) : null}
				</p>
			) : null}
			{variant === 'embed' ? (
				post.link === null ? null : (
					<p class="meta">
						<LinkTo link={post.link}>{m.post.viewOn(post.link.host)}</LinkTo>
					</p>
				)
			) : (
				<Counts items={post.counts} />
			)}
		</article>
	)
}

// A post too large to show on its page (design §2): a compact row of its author's address, its date and "Open", both
// linking to it.
export const PostStub: FC<{ stub: StubView }> = ({ stub }) => {
	const { m, f } = useUi()
	const date = <DateTime iso={stub.createdAt} text={f.instant(stub.createdAt)} local />
	return (
		<article class="card post">
			<p class="meta">
				<span class="handle">{stub.address}</span>
				{' · '}
				{stub.link === null ? date : <LinkTo link={stub.link}>{date}</LinkTo>}
				{stub.link === null ? null : (
					<>
						{' · '}
						<LinkTo link={stub.link}>{m.post.open}</LinkTo>
					</>
				)}
			</p>
		</article>
	)
}
