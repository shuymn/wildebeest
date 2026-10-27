import type { Child, FC } from 'hono/jsx'

import { Card } from './basics'
import { Dialog } from './dialog'
import { Icon } from './icon'
import type { IconName } from '../icons'
import type { Messages } from '../messages'
import { useUi } from '../ui'
import { interactPath, type RemoteTarget } from '../view/remote'

// Following and interacting from another server (design §8, §11: CopyField, RemoteForm, Panel): the profile's and the
// status's dialogs and the handoff pages share one body, a GET form naming the viewer's server and the address to
// search for there.

// The ids of the dialogs their pages open.
export const FOLLOW_DIALOG = 'follow'
export const INTERACT_DIALOG = 'interact'
export const EMBED_DIALOG = 'embed'

// A value to copy, shown whole and wrapping, with its copy button (design §7.7): rendered hidden, and shown by the L1
// bundle on the pages that load it; elsewhere the value is selected and copied by hand. Its slot is reserved, so the
// button appears without moving anything (§13), and its result goes into the field's status element.
export const CopyField: FC<{ value: string; label: string; copyLabel: string }> = ({ value, label, copyLabel }) => {
	const { m } = useUi()
	return (
		<div class="copyfield">
			<p class="hint">{label}</p>
			<div class="copy">
				<span class="mono">{value}</span>
				<span class="slot">
					<button
						type="button"
						class="btn quiet icon"
						hidden
						data-copy={value}
						data-copied={m.copy.copied}
						data-failed={m.copy.failed}
					>
						<Icon name="copy" size={18} label={copyLabel} />
					</button>
				</span>
			</div>
			<p class="hint" role="status" />
		</div>
	)
}

// The form naming the viewer's server: a GET to the target's handoff page. `field` prefixes its ids, unique on the
// page; `autofocus` only inside a dialog (§8, §14.8); `problem` when the server given was refused, which the page
// says with the same bytes whatever was given, so nothing given is shown again.
export const RemoteForm: FC<{ action: string; field: string; autofocus: boolean; problem?: boolean }> = ({
	action,
	field,
	autofocus,
	problem = false,
}) => {
	const { m } = useUi()
	const hint = `${field}-hint`
	const refusal = `${field}-problem`
	return (
		<form method="get" action={action} class="stack">
			{problem ? (
				<p class="problems" id={refusal} role="alert">
					{m.remote.invalidServer}
				</p>
			) : null}
			<label>
				{m.remote.server}
				<input
					type="text"
					name="server"
					required
					inputmode="url"
					autocapitalize="none"
					spellcheck={false}
					autofocus={autofocus ? true : undefined}
					aria-invalid={problem ? 'true' : undefined}
					aria-describedby={problem ? `${refusal} ${hint}` : hint}
				/>
			</label>
			<p class="hint" id={hint}>
				{m.remote.serverHint}
			</p>
			<button type="submit" class="btn primary">
				{m.remote.go}
			</button>
		</form>
	)
}

// What to search for on another server, as the target's kind names it.
export const SearchField: FC<{ target: RemoteTarget; label?: string }> = ({ target, label }) => {
	const { m } = useUi()
	const account = target.kind === 'account'
	return (
		<CopyField
			value={target.search}
			label={label ?? (account ? m.remote.searchHandle : m.remote.searchUrl)}
			copyLabel={account ? m.copy.copyHandle : m.copy.copyUrl}
		/>
	)
}

// The title and prompt of a target's dialog or handoff form.
export function remoteTitle(target: RemoteTarget, m: Messages): { title: string; prompt: string } {
	return target.kind === 'account'
		? { title: m.remote.followTitle(target.name ?? ''), prompt: m.remote.followPrompt }
		: { title: m.remote.openTitle, prompt: m.remote.openPrompt }
}

// The body the dialog and the handoff form page share: the prompt, the form, then the address to search for.
export const RemoteChoice: FC<{ target: RemoteTarget; field: string; autofocus: boolean; problem?: boolean }> = ({
	target,
	field,
	autofocus,
	problem,
}) => {
	const { m } = useUi()
	return (
		<>
			<p>{remoteTitle(target, m).prompt}</p>
			<RemoteForm action={interactPath(target.path)} field={field} autofocus={autofocus} problem={problem} />
			<p class="or">{m.remote.or}</p>
			<SearchField target={target} />
		</>
	)
}

// The profile's follow dialog or the status's: focus on the server field (§8), and no light dismiss, which would lose
// what was typed (amendment A7).
export const RemoteDialog: FC<{ id: string; target: RemoteTarget }> = ({ id, target }) => {
	const { m } = useUi()
	return (
		<Dialog id={id} title={remoteTitle(target, m).title} focus="content" lightDismiss={false}>
			<RemoteChoice target={target} field={`${id}-server`} autofocus />
		</Dialog>
	)
}

// The status's embed code (design §7.1), the oEmbed html as Mastodon's web client offers it: nothing is typed in it,
// so focus on its heading and light dismiss (amendments A5, A7).
export const EmbedDialog: FC<{ code: string }> = ({ code }) => {
	const { m } = useUi()
	return (
		<Dialog id={EMBED_DIALOG} title={m.embed.title} focus="heading" lightDismiss>
			<CopyField value={code} label={m.embed.prompt} copyLabel={m.copy.copyCode} />
		</Dialog>
	)
}

// A page's one card, led by its h1 with a decorative icon (the handoff pages).
export const Panel: FC<{ icon: IconName; title: string; children?: Child }> = ({ icon, title, children }) => (
	<Card as="section" class="pad">
		<h1 class="titled">
			<Icon name={icon} size={22} decorative />
			{title}
		</h1>
		{children}
	</Card>
)
