import type { FC } from 'hono/jsx'

import { BackLink, Card } from './components/basics'
import { Layout } from './components/layout'
import type { SetupView } from '../domain/setup'

// The /setup wizard's pages (B5b), in the web UI's style: server-rendered, no script, every value escaped by hono/jsx.
// The Cloudflare API token field is never filled in (SETUP-4): a page never contains a token.

export type CheckStatus = 'pass' | 'warn' | 'fail'

export type CheckResult = { status: CheckStatus; text: string; hint?: string }

export type SetupStep = 'domain' | 'access' | 'images' | 'queue' | 'bot' | 'admin'

const STATUS_LABEL: Record<CheckStatus, string> = { pass: 'Pass', warn: 'Warning', fail: 'Fail' }

const Result: FC<{ result: CheckResult | undefined }> = ({ result }) =>
	result === undefined ? null : (
		<div class={`result ${result.status}`} role="status">
			<p>
				<strong>{STATUS_LABEL[result.status]}:</strong> {result.text}
			</p>
			{result.hint === undefined ? null : <p class="hint">{result.hint}</p>}
		</div>
	)

const Csrf: FC<{ token: string }> = ({ token }) => <input type="hidden" name="csrf" value={token} />

const Checklist: FC = () => (
	<p>
		Some steps cannot be done from here: see the <a href="/setup/checklist">checklist of manual steps</a>.
	</p>
)

export const SetupLoginPage: FC<{ problem: string | null }> = ({ problem }) => (
	<Layout title="Set up Kopje" chrome={null}>
		<Card as="section" class="pad">
			<h1>Set up Kopje</h1>
			<p>Enter the setup token (the SETUP_TOKEN secret of this Worker) to start.</p>
			{problem === null ? null : (
				<div class="problems" role="alert">
					<p>{problem}</p>
				</div>
			)}
			<form method="post" action="/setup/login">
				<label>
					Setup token
					<input type="password" name="token" autocomplete="off" required />
				</label>
				<button type="submit">Continue</button>
			</form>
			<Checklist />
		</Card>
	</Layout>
)

// After bootstrap, for anyone who is not the signed-in admin (SETUP-2): SETUP_TOKEN no longer opens anything.
export const SetupDonePage: FC = () => (
	<Layout title="Setup complete" chrome={null}>
		<Card as="section" class="pad">
			<h1>Setup complete</h1>
			<p>
				This server is set up. The setup token no longer changes anything; you can remove the SETUP_TOKEN secret. The
				admin can sign in to see the status, run the checks again and update the Access applications.
			</p>
			<p>
				<a href="/login?return=%2Fsetup">Sign in as the admin</a>
			</p>
		</Card>
	</Layout>
)

export type SetupPageProps = {
	mode: 'setup' | 'admin'
	host: string
	// Why the host cannot be the instance domain, or null.
	hostProblem: string | null
	csrf: string
	view: SetupView
	results: Partial<Record<SetupStep, CheckResult>>
	queue: CheckResult
	cron: CheckResult
	images: CheckResult | undefined
	accessState: CheckResult | undefined
}

const PERMISSIONS = (
	<ul class="list">
		<li>
			Account, <em>Access: Apps and Policies</em>, Edit (required)
		</li>
		<li>
			Account, <em>Access: Organizations, Identity Providers, and Groups</em>, Read (required: checks that the team is
			this account's)
		</li>
		<li>
			Account, <em>Access: Service Tokens</em>, Read (only with a service token client ID)
		</li>
		<li>
			Account, <em>Account Settings</em>, Read (only to find the account when no account ID is entered)
		</li>
	</ul>
)

export const SetupPage: FC<SetupPageProps> = ({
	mode,
	host,
	hostProblem,
	csrf,
	view,
	results,
	queue,
	cron,
	images,
	accessState,
}) => {
	const admin = mode === 'admin'
	const domain = admin ? (view.config?.domain ?? null) : (view.draft?.domain ?? null)
	const confirmed = domain !== null && domain === host
	const access = view.draft?.access ?? null
	const teamDomain = admin ? (view.config?.teamDomain ?? null) : (access?.teamDomain ?? null)
	const adminEmail = admin ? (view.config?.adminEmail ?? '') : (access?.adminEmail ?? '')
	return (
		<Layout title={admin ? 'Instance status' : 'Set up Kopje'} chrome={null}>
			<div class="intro">
				<h1>{admin ? 'Instance status' : 'Set up Kopje'}</h1>
				{admin ? (
					<p>
						Signed in as the admin, <strong>@{view.config?.adminUsername ?? ''}</strong>. The domain and the admin are
						fixed; the checks and the Access applications can be run again.
					</p>
				) : (
					<p>Go through the steps in order. Each one can be run again.</p>
				)}
				<Checklist />
			</div>
			<ol class="steps sections">
				<li class="stack">
					<h2>Domain</h2>
					<div class="card pad">
						{admin ? (
							<p>
								The instance domain is <strong>{domain ?? ''}</strong>. It cannot be changed.
							</p>
						) : (
							<>
								<p>
									Kopje serves this server at <strong>{host}</strong>. Actor ids are made from it, so it cannot be
									changed after setup.
								</p>
								<p class="state">{confirmed ? `Confirmed: ${host}` : 'Not confirmed yet.'}</p>
								<Result
									result={results.domain ?? (hostProblem === null ? undefined : { status: 'fail', text: hostProblem })}
								/>
								{hostProblem === null ? (
									<form method="post" action="/setup/domain">
										<Csrf token={csrf} />
										<input type="hidden" name="domain" value={host} />
										<button type="submit">Use {host}</button>
									</form>
								) : null}
							</>
						)}
					</div>
				</li>
				<li class="stack">
					<h2>Zero Trust and Access</h2>
					<div class="card pad">
						<p>
							Access protects sign-in (<code>/oauth/authorize</code>) and <code>/admin</code> with two applications.
							Kopje checks your Zero Trust team, then creates or updates both applications and their policies with a
							short-lived API token. The token is used for this one request only and is not kept.
						</p>
						<p class="state">
							{teamDomain === null
								? 'Not configured yet.'
								: `Team: ${teamDomain}${admin || access === null ? '' : `, account ${access.accountId}`}`}
						</p>
						<Result result={results.access ?? accessState} />
						{admin || confirmed ? (
							<form method="post" action="/setup/access">
								<Csrf token={csrf} />
								<label>
									<span>
										Zero Trust team name (the <em>team</em> of team.cloudflareaccess.com)
									</span>
									<input type="text" name="team" value={teamDomain ?? ''} required maxlength={100} />
								</label>
								<label>
									Account ID (optional)
									<input type="text" name="account_id" value={access?.accountId ?? ''} maxlength={32} />
								</label>
								{admin ? (
									<p>
										Admin email: <strong>{adminEmail}</strong>
										<input type="hidden" name="admin_email" value={adminEmail} />
									</p>
								) : (
									<label>
										The admin's email, as Access will assert it
										<input type="email" name="admin_email" value={adminEmail} required maxlength={254} />
									</label>
								)}
								<label>
									Client ID of the admin CLI's service token (optional)
									<input
										type="text"
										name="service_token_client_id"
										value={(admin ? view.config?.serviceTokenClientId : access?.serviceTokenClientId) ?? ''}
										maxlength={100}
									/>
								</label>
								<div class="field">
									<label>
										Cloudflare API token
										<input
											type="password"
											name="api_token"
											autocomplete="off"
											required
											maxlength={200}
											aria-describedby="api-token-hint"
										/>
									</label>
									<p class="hint" id="api-token-hint">
										Create a token with these permissions, and a short expiry:
									</p>
									{PERMISSIONS}
								</div>
								<fieldset>
									<legend>Existing objects</legend>
									<label class="check">
										<input type="radio" name="mode" value="reconcile" checked />
										Update the objects Kopje made (normal)
									</label>
									<label class="check">
										<input type="radio" name="mode" value="adopt" />
										Recovery: take over the objects with Kopje's names, whatever they are now
									</label>
									<label class="check">
										<input type="radio" name="mode" value="recreate" />
										Recovery: create new objects (delete the old ones in the dashboard afterwards)
									</label>
								</fieldset>
								<button type="submit">{teamDomain === null ? 'Create' : 'Update'} the Access applications</button>
							</form>
						) : (
							<p class="hint">Confirm the domain first.</p>
						)}
					</div>
				</li>
				<li class="stack">
					<h2>Images</h2>
					<div class="card pad">
						<p>
							Uploads are re-encoded through the Images binding. This transforms a tiny image (one transformation of the
							monthly allowance; the free plan includes 5,000).
						</p>
						<Result result={results.images ?? images} />
						<form method="post" action="/setup/check/images">
							<Csrf token={csrf} />
							<button type="submit">Check Images</button>
						</form>
					</div>
				</li>
				<li class="stack">
					<h2>Queue and cron</h2>
					<div class="card pad">
						<Result result={results.queue ?? queue} />
						<Result result={cron} />
						<form method="post" action="/setup/check/queue">
							<Csrf token={csrf} />
							<button type="submit">Send a probe message</button>
						</form>
						<p class="hint">
							<a href="/setup">Reload</a> after a few seconds to see whether the consumer received it.
						</p>
					</div>
				</li>
				<li class="stack">
					<h2>Bot Fight Mode</h2>
					<div class="card pad">
						<p>
							Bot Fight Mode challenges requests that look automated. Other servers deliver activities and fetch actors
							without a browser, so it blocks federation: turn it off for this zone (Security, Bots). It cannot be
							skipped for some paths.
						</p>
						<Result result={results.bot} />
						<form method="post" action="/setup/check/bot-fight">
							<Csrf token={csrf} />
							<label>
								Cloudflare API token with Zone Read and Bot Management Read (optional)
								<input type="password" name="api_token" autocomplete="off" maxlength={200} />
							</label>
							<button type="submit">Check Bot Fight Mode</button>
						</form>
					</div>
				</li>
				{admin ? null : (
					<li class="stack">
						<h2>The admin</h2>
						<div class="card pad">
							<p>
								The first account, and the only one that may use <code>/admin</code>. Access must admit its email (step
								2). This fixes the domain and the admin for good.
							</p>
							<Result result={results.admin} />
							{access === null || !confirmed || view.draft?.accessReady !== true ? (
								<p class="hint">Set up the Access applications first.</p>
							) : (
								<form method="post" action="/setup/admin">
									<Csrf token={csrf} />
									<label>
										Username
										<input type="text" name="username" required maxlength={30} pattern="[A-Za-z0-9_]+" />
									</label>
									<label>
										Email
										<input type="email" name="email" value={access.adminEmail} required maxlength={254} />
									</label>
									<button type="submit">Create the admin and finish</button>
								</form>
							)}
						</div>
					</li>
				)}
			</ol>
			{admin ? null : (
				<form method="post" action="/setup/logout">
					<Csrf token={csrf} />
					<button type="submit" class="danger">
						Leave setup
					</button>
				</form>
			)}
		</Layout>
	)
}

export const ChecklistPage: FC = () => (
	<Layout title="Manual steps" chrome={null}>
		<BackLink href="/setup" label="Back to setup" />
		<Card as="section" class="pad">
			<h1>Manual steps</h1>
			<p>These steps cannot be automated. Do them in the Cloudflare dashboard before or during setup.</p>
			<ol class="list">
				<li>
					<strong>Add the zone.</strong> The instance domain must be on a zone of this Cloudflare account, and the
					Worker must have a custom domain or a route on it. A workers.dev address cannot be used: Access cannot protect
					paths there, and the domain cannot change later.
				</li>
				<li>
					<strong>Create the Zero Trust organization.</strong> Choose a team name and a plan (the Free plan is enough),
					which asks for payment details. Add a login method (one-time PIN works).
				</li>
				<li>
					<strong>Create a short-lived API token</strong> for step 2 with Access: Apps and Policies, Edit, and Access:
					Organizations, Identity Providers, and Groups, Read. Delete it afterwards.
				</li>
				<li>
					<strong>Optional: a service token for the admin CLI.</strong> Create it under Access, Service credentials, and
					enter its client ID in step 2. Keep the client secret for the CLI.
				</li>
				<li>
					<strong>Optional: Images Paid.</strong> Without it, 5,000 transformations a month are included; each upload
					uses up to three. Raise IMAGES_MONTHLY_TRANSFORMS after buying more.
				</li>
				<li>
					<strong>Turn off Bot Fight Mode</strong> for the zone.
				</li>
				<li>
					<strong>Set the secrets</strong>: SETUP_TOKEN (at least 32 characters) for this wizard, USER_KEK before the
					first account is made, and remove SETUP_TOKEN once setup is complete.
				</li>
			</ol>
		</Card>
	</Layout>
)
