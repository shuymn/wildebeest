import type { FC } from 'hono/jsx'

import { Card } from '../components/basics'
import { Layout } from '../components/layout'
import { useUi } from '../ui'

// The pages of /oauth/authorize (app/authorize.tsx): the consent form and the out-of-band code. Script-free (WEB-2),
// and without the site's chrome: the flow reads only what it checks from the Store. Its refusals are MessagePage.

// The fields the consent form posts back to /oauth/authorize, where every one of them is validated again.
export type ConsentFields = {
	client_id: string
	redirect_uri: string
	scope: string
	state?: string
	code_challenge?: string
	code_challenge_method?: string
}

export const ConsentPage: FC<{
	appName: string
	website: string | null
	username: string
	scopes: string[]
	fields: ConsentFields
	// The instance's own web UI (domain/web-session.ts): the same decision, worded as signing in.
	firstParty?: boolean
}> = ({ appName, website, username, scopes, fields, firstParty = false }) => {
	const { m } = useUi()
	const title = firstParty ? m.signIn.signIn : m.oauth.title(appName)
	return (
		<Layout title={title} chrome={null}>
			<Card as="section" class="pad">
				<h1>{title}</h1>
				{firstParty ? (
					<p>
						{m.signIn.signInAs} <strong>@{username}</strong>?
					</p>
				) : (
					// The website is the client's own claim at registration: shown as text, never followed from here.
					<dl class="fields">
						{website === null ? null : (
							<div>
								<dt>{m.oauth.website}</dt>
								<dd>{website}</dd>
							</div>
						)}
						<div>
							<dt>{m.oauth.account}</dt>
							<dd>@{username}</dd>
						</div>
						<div>
							<dt>{m.oauth.scopes}</dt>
							<dd>
								<ul class="scopes" role="list">
									{scopes.map((scope) => (
										<li>
											<code>{scope}</code>
										</li>
									))}
								</ul>
							</dd>
						</div>
					</dl>
				)}
				<form method="post" action="/oauth/authorize" class="actions">
					{Object.entries(fields).map(([name, value]) =>
						value === undefined ? null : <input type="hidden" name={name} value={value} />
					)}
					<button type="submit" class="btn primary" name="decision" value="approve">
						{firstParty ? m.signIn.signIn : m.oauth.approve}
					</button>
					<button type="submit" class="btn" name="decision" value="deny">
						{firstParty ? m.signIn.cancel : m.oauth.deny}
					</button>
				</form>
			</Card>
		</Layout>
	)
}

// For urn:ietf:wg:oauth:2.0:oob: the code, whole and wrapping, to select and copy by hand (no copy control: the page
// runs no script).
export const CodePage: FC<{ code: string }> = ({ code }) => {
	const { m } = useUi()
	return (
		<Layout title={m.oauth.codeTitle} chrome={null}>
			<Card as="section" class="pad">
				<h1>{m.oauth.codeTitle}</h1>
				<div class="copyfield">
					<p class="hint">{m.oauth.codePrompt}</p>
					<div class="copy">
						<code class="mono">{code}</code>
					</div>
				</div>
			</Card>
		</Layout>
	)
}
