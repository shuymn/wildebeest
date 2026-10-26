import type { FC } from 'hono/jsx'

import type { InteractionTarget } from '../../domain/interaction'
import type { Site } from '../../domain/web-pages/site'
import { Card, LinkButton } from '../components/basics'
import { Layout } from '../components/layout'
import { PostCard } from '../components/post'
import { ProfileCard } from '../components/profile'
import { useUi } from '../ui'
import { accountView, address, displayName } from '../view/account'
import { postView } from '../view/post'

// /authorize_interaction (design §8): the look-up form, and what a look-up found with the form that follows it. Both
// post with the session's anti-forgery token when there is a session (WEB-4); without one, the look-up goes to sign
// in first and comes back to this form.

const LOOK_UP = '/authorize_interaction'
const FOLLOW = '/authorize_interaction/follow'
const TARGET_HINT = 'interaction-target-hint'

const Csrf: FC<{ token: string | null }> = ({ token }) =>
	token === null ? null : <input type="hidden" name="csrf" value={token} />

export const InteractionPage: FC<{ site: Site; uri: string; csrf: string | null }> = ({ site, uri, csrf }) => {
	const { m } = useUi()
	return (
		<Layout title={m.interact.title} chrome={site}>
			<Card as="section" class="pad">
				<h1>{m.interact.title}</h1>
				<p>{m.interact.lookUpPrompt}</p>
				<form method="post" action={LOOK_UP}>
					<Csrf token={csrf} />
					<label>
						{m.interact.target}
						<input
							type="text"
							name="uri"
							value={uri}
							required
							inputmode="url"
							spellcheck={false}
							aria-describedby={TARGET_HINT}
						/>
					</label>
					<p class="hint" id={TARGET_HINT}>
						{m.interact.targetHint}
					</p>
					<button type="submit">{m.interact.lookUp}</button>
				</form>
			</Card>
		</Layout>
	)
}

// The follow of an account the look-up found; `uri` is the look-up's target, so a session that has to sign in again
// comes back to it.
const FollowForm: FC<{ accountId: string; uri: string; csrf: string; label: string }> = ({
	accountId,
	uri,
	csrf,
	label,
}) => (
	<form method="post" action={FOLLOW}>
		<Csrf token={csrf} />
		<input type="hidden" name="account_id" value={accountId} />
		<input type="hidden" name="uri" value={uri} />
		<button type="submit">{label}</button>
	</form>
)

// What a look-up found, as an anonymous viewer would see it (VIS-4): an account with its follow form, or a post with
// the follow form of its author.
export const InteractionResultPage: FC<{
	site: Site
	target: Exclude<InteractionTarget, { kind: 'not_found' }>
	uri: string
	csrf: string
}> = ({ site, target, uri, csrf }) => {
	const { m } = useUi()
	const { domain } = site
	const account = target.kind === 'account' ? target.account : target.status.account
	const name = displayName(account)
	return (
		<Layout title={m.profile.title(name, address(account, domain))} chrome={site}>
			{target.kind === 'account' ? (
				<ProfileCard account={accountView(target.account, domain)} />
			) : (
				<PostCard post={postView(target.status, null, domain)} variant="focal" />
			)}
			<div class="actions">
				<FollowForm
					accountId={account.id}
					uri={uri}
					csrf={csrf}
					label={target.kind === 'account' ? m.interact.follow : m.interact.followAuthor(name)}
				/>
				<LinkButton href={LOOK_UP}>{m.interact.lookUpAnother}</LinkButton>
			</div>
		</Layout>
	)
}
