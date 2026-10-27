import type { Child, FC } from 'hono/jsx'

import { Rich } from './basics'
import { Avatar, InlineText } from './post'
import { useUi } from '../ui'
import type { AccountView, FieldView } from '../view/account'

// The profile card (design §11): banner, avatar, name as the page's h1, address, bio, fields and counts. The banner and
// the avatar are the page's eager images (§13, amendment A5).

// Profile fields as a description list; each value is sanitized at its sink and its links keep rel="me".
export const Fields: FC<{ fields: FieldView[] }> = ({ fields }) =>
	fields.length === 0 ? null : (
		<dl class="fields">
			{fields.map((field) => (
				<div>
					<dt>
						<InlineText text={field.name} />
					</dt>
					<dd dangerouslySetInnerHTML={{ __html: field.value.html }} />
				</div>
			))}
		</dl>
	)

type FollowLinks = Record<'following' | 'followers', string>

// The counts; a local account's following and followers link to its follow lists (`follows`), another server's do not.
export const Stats: FC<{ stats: AccountView['stats']; follows?: FollowLinks }> = ({ stats, follows }) => {
	const { m, f } = useUi()
	return (
		<ul class="stats" role="list">
			<li>
				<strong>{f.count(stats.posts)}</strong> {m.profile.posts}
			</li>
			{(['following', 'followers'] as const).map((direction) => {
				const count = (
					<>
						<strong>{f.count(stats[direction])}</strong> {m.profile[direction]}
					</>
				)
				return <li>{follows === undefined ? count : <a href={follows[direction]}>{count}</a>}</li>
			})}
		</ul>
	)
}

// `action`: the control beside the avatar (the profile page's Follow).
export const ProfileCard: FC<{ account: AccountView; follows?: FollowLinks; action?: Child }> = ({
	account,
	follows,
	action,
}) => (
	<section class="card profile">
		{account.header === null ? (
			<div class="banner" />
		) : (
			<img class="banner" src={account.header} alt="" fetchpriority="high" decoding="async" />
		)}
		<div class="pbody">
			{action === undefined ? (
				<Avatar src={account.avatar} size={88} eager />
			) : (
				<div class="prow">
					<Avatar src={account.avatar} size={88} eager />
					{action}
				</div>
			)}
			<div>
				<h1 class="pname">
					<InlineText text={account.name} />
				</h1>
				<p class="handle">{account.address}</p>
			</div>
			{account.bio === null ? null : <Rich class="body" html={account.bio} />}
			<Fields fields={account.fields} />
			<Stats stats={account.stats} follows={follows} />
		</div>
	</section>
)
