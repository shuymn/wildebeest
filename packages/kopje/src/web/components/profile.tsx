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

export const Stats: FC<{ stats: AccountView['stats'] }> = ({ stats }) => {
	const { m, f } = useUi()
	const items: [number, string][] = [
		[stats.posts, m.profile.posts],
		[stats.following, m.profile.following],
		[stats.followers, m.profile.followers],
	]
	return (
		<ul class="stats">
			{items.map(([n, label]) => (
				<li>
					<strong>{f.count(n)}</strong> {label}
				</li>
			))}
		</ul>
	)
}

export const ProfileCard: FC<{ account: AccountView }> = ({ account }) => (
	<section class="card profile" aria-labelledby="profile-name">
		{account.header === null ? (
			<div class="banner" />
		) : (
			<img class="banner" src={account.header} alt="" fetchpriority="high" decoding="async" />
		)}
		<div class="pbody">
			<Avatar src={account.avatar} size={88} eager />
			<div>
				<h1 class="pname" id="profile-name">
					<InlineText text={account.name} />
				</h1>
				<p class="handle">{account.address}</p>
			</div>
			{account.bio === null ? null : <Rich class="body" html={account.bio} />}
			<Fields fields={account.fields} />
			<Stats stats={account.stats} />
		</div>
	</section>
)
