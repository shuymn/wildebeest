import type { FC } from 'hono/jsx'

import { httpUrl } from '../../platform/http-url'
import { Alert, Card, VisuallyHidden } from '../components/basics'
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

type ScopeGroup = 'read' | 'write' | 'follow' | 'push' | 'admin'

const GROUPS: ScopeGroup[] = ['read', 'write', 'follow', 'push', 'admin']

// A scope's group in plain language: `read` and `profile` read, `write` writes, the admin scopes administer, and
// `follow` and `push` stand alone (src/security/scopes.ts).
function groupOf(scope: string): ScopeGroup {
	if (scope.startsWith('admin:')) {
		return 'admin'
	}
	if (scope === 'profile' || scope.startsWith('read')) {
		return 'read'
	}
	return scope.startsWith('write') ? 'write' : scope === 'follow' ? 'follow' : 'push'
}

// The consent form: the app, its website as its host only (the whole URL in hidden text, so a long one never runs on),
// the account by its full address, and the permissions it asks for in plain language by group, each with its scopes'
// names in small text; admin scopes stand apart in a warning. The page's heading is above its card, as every page's.
export const ConsentPage: FC<{
	appName: string
	website: string | null
	username: string
	// The instance's domain, which names the account in full.
	domain: string
	scopes: string[]
	fields: ConsentFields
	// The instance's own web UI (domain/web-session.ts): the same decision, worded as signing in.
	firstParty?: boolean
}> = ({ appName, website, username, domain, scopes, fields, firstParty = false }) => {
	const { m } = useUi()
	const title = firstParty ? m.signIn.signIn : m.oauth.title(appName)
	const account = `@${username}@${domain}`
	const host = website === null ? null : (httpUrl(website)?.host ?? website)
	const grouped = GROUPS.map((group) => ({ group, scopes: scopes.filter((scope) => groupOf(scope) === group) })).filter(
		({ scopes }) => scopes.length > 0
	)
	const admin = grouped.find(({ group }) => group === 'admin')
	return (
		<Layout title={title} chrome={null}>
			<h1>{title}</h1>
			<Card as="section" class="pad">
				{firstParty ? (
					<p>
						{m.signIn.signInAs} <span class="muted">{account}</span>?
					</p>
				) : (
					<>
						{admin === undefined ? null : (
							<Alert status="warn" title={m.oauth.admin}>
								<p>{admin.scopes.join(' ')}</p>
							</Alert>
						)}
						{/* The website is the client's own claim at registration: shown as text, never followed from here. */}
						<dl class="fields">
							{host === null ? null : (
								<div>
									<dt>{m.oauth.website}</dt>
									{/* Its host, one line; the whole of it for assistive technology (no title: design §14). */}
									<dd class="oneline">
										{host}
										{website === host ? null : <VisuallyHidden>{` (${website})`}</VisuallyHidden>}
									</dd>
								</div>
							)}
							<div>
								<dt>{m.oauth.account}</dt>
								<dd>{account}</dd>
							</div>
							<div>
								<dt>{m.oauth.scopes}</dt>
								<dd>
									<ul class="scopes" role="list">
										{grouped
											.filter(({ group }) => group !== 'admin')
											.map(({ group, scopes }) => (
												<li class="group">
													<span>{m.oauth.scopeGroups[group]}</span>
													<span class="hint">{scopes.join(' ')}</span>
												</li>
											))}
									</ul>
								</dd>
							</div>
						</dl>
					</>
				)}
				<form method="post" action="/oauth/authorize">
					{Object.entries(fields).map(([name, value]) =>
						value === undefined ? null : <input type="hidden" name={name} value={value} />
					)}
					<div class="actions">
						<button type="submit" class="btn primary" name="decision" value="approve">
							{firstParty ? m.signIn.signIn : m.oauth.approve}
						</button>
						<button type="submit" class="btn" name="decision" value="deny">
							{firstParty ? m.signIn.cancel : m.oauth.deny}
						</button>
					</div>
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
			<h1>{m.oauth.codeTitle}</h1>
			<Card as="section" class="pad">
				<div class="copyfield">
					<p class="flabel">{m.oauth.codePrompt}</p>
					<div class="copy">
						<code class="mono">{code}</code>
					</div>
				</div>
			</Card>
		</Layout>
	)
}
