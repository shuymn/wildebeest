import type { FC } from 'hono/jsx'

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
					<dt>{field.name}</dt>
					<dd dangerouslySetInnerHTML={{ __html: field.value.html }} />
				</div>
			))}
		</dl>
	)

// The counts; following and followers link to their lists (`follows`), which link back (design §17, PR 5).
export const Stats: FC<{ stats: AccountView['stats']; follows: Record<'following' | 'followers', string> }> = ({
	stats,
	follows,
}) => {
	const { m, f } = useUi()
	return (
		<ul class="stats" role="list">
			<li>
				<strong>{f.count(stats.posts)}</strong> {m.profile.posts}
			</li>
			{(['following', 'followers'] as const).map((direction) => (
				<li>
					<a href={follows[direction]}>
						<strong>{f.count(stats[direction])}</strong> {m.profile[direction]}
					</a>
				</li>
			))}
		</ul>
	)
}

export const ProfileCard: FC<{ account: AccountView; follows: Record<'following' | 'followers', string> }> = ({
	account,
	follows,
}) => (
	<section class="card profile">
		{account.header === null ? (
			<div class="banner" />
		) : (
			<img class="banner" src={account.header} alt="" fetchpriority="high" decoding="async" />
		)}
		<div class="pbody">
			<Avatar src={account.avatar} size={88} eager />
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
