import type { Child, FC } from 'hono/jsx'

import { STRINGS } from './strings'

// The OAuth consent page and its messages: plain server-rendered HTML with no script (the response carries
// script-src 'none'). hono/jsx escapes every interpolated value. The full web UI comes in a later stage.

const STYLE = `body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
ul{padding-left:1.25rem}code{word-break:break-all}.actions{display:flex;gap:.75rem;margin-top:1.5rem}
button{font:inherit;padding:.5rem 1.25rem;cursor:pointer}`

const Layout: FC<{ title: string; children: Child }> = ({ title, children }) => (
	<html lang="en">
		<head>
			<meta charset="utf-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1" />
			<meta name="referrer" content="no-referrer" />
			<title>{title}</title>
			<style>{STYLE}</style>
		</head>
		<body>
			<main>
				<h1>{title}</h1>
				{children}
			</main>
		</body>
	</html>
)

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
}> = ({ appName, website, username, scopes, fields, firstParty = false }) => (
	<Layout title={firstParty ? STRINGS.signIn : 'Authorization required'}>
		{firstParty ? (
			<p>
				{STRINGS.signInAs} <strong>@{username}</strong>?
			</p>
		) : (
			<>
				<p>
					<strong>{appName}</strong>
					{website === null ? '' : ` (${website})`} wants to access the account <strong>@{username}</strong>.
				</p>
				<p>It is asking for these permissions:</p>
				<ul>
					{scopes.map((scope) => (
						<li>
							<code>{scope}</code>
						</li>
					))}
				</ul>
			</>
		)}
		<form method="post" action="/oauth/authorize">
			{Object.entries(fields).map(([name, value]) =>
				value === undefined ? null : <input type="hidden" name={name} value={value} />
			)}
			<div class="actions">
				<button type="submit" name="decision" value="approve">
					{firstParty ? STRINGS.signIn : 'Authorize'}
				</button>
				<button type="submit" name="decision" value="deny">
					{firstParty ? STRINGS.cancel : 'Deny'}
				</button>
			</div>
		</form>
	</Layout>
)

export const MessagePage: FC<{ title: string; message: string }> = ({ title, message }) => (
	<Layout title={title}>
		<p>{message}</p>
	</Layout>
)

// For urn:ietf:wg:oauth:2.0:oob: the user copies the code into the app.
export const CodePage: FC<{ code: string }> = ({ code }) => (
	<Layout title="Authorization code">
		<p>Copy this code and paste it into the application:</p>
		<p>
			<code>{code}</code>
		</p>
	</Layout>
)
