import type { Child, FC } from 'hono/jsx'

import { Card, FieldError } from './basics'
import { Dialog } from './dialog'
import { Icon } from './icon'
import { InlineText } from './post'
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
// `oneLine`: a long value (the embed code) shows one line cut with an ellipsis; the whole of it is still the text
// that is selected and copied.
export const CopyField: FC<{ value: string; label: string; copyLabel: string; oneLine?: boolean }> = ({
	value,
	label,
	copyLabel,
	oneLine = false,
}) => {
	const { m } = useUi()
	return (
		<div class={oneLine ? 'copyfield one-line' : 'copyfield'}>
			<p class="flabel">{label}</p>
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
		<form method="get" action={action}>
			<div class="field">
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
						aria-describedby={problem ? refusal : hint}
					/>
				</label>
				{/* While the error shows, it stands in for the hint. */}
				{problem ? (
					<FieldError id={refusal}>{m.remote.invalidServer}</FieldError>
				) : (
					<p class="hint" id={hint}>
						{m.remote.serverHint}
					</p>
				)}
			</div>
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

// The title of a target's dialog or handoff form, as text for <title> and as its heading (a name with its custom
// emoji), and its prompt.
export function remoteTitle(target: RemoteTarget, m: Messages): { title: string; heading: Child; prompt: string } {
	return target.name === null
		? { title: m.remote.openTitle, heading: m.remote.openTitle, prompt: m.remote.openPrompt }
		: {
				title: m.remote.followTitle(target.name.text),
				heading: m.remote.followHeading(<InlineText text={target.name.inline} />),
				prompt: m.remote.followPrompt,
			}
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
		<Dialog id={id} title={remoteTitle(target, m).heading} focus="content" lightDismiss={false}>
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
			<CopyField value={code} label={m.embed.prompt} copyLabel={m.copy.copyCode} oneLine />
		</Dialog>
	)
}

// A page for following or interacting (design §8): its heading, above its card as every page's is. `oneLine`: a
// heading that names a server the viewer typed stays one line, cut with an ellipsis (the whole of it stays the
// heading's text).
export const Panel: FC<{ title: Child; oneLine?: boolean; children?: Child }> = ({
	title,
	oneLine = false,
	children,
}) => (
	<>
		{oneLine ? <h1 class="oneline">{title}</h1> : <h1>{title}</h1>}
		<Card as="section" class="pad">
			{children}
		</Card>
	</>
)
