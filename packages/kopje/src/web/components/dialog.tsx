import type { Child, FC } from 'hono/jsx'

import { Icon } from './icon'
import { useUi } from '../ui'

// Dialogs: a modal <dialog>, rendered closed and named by its heading, opened by a button with command="show-modal" and
// closed by its close button or Esc, with no script (the invoker commands of current browsers; no fallback for older
// ones, docs/web-pages.md). The browser returns focus to the invoker when it closes. hono/jsx passes `command`,
// `commandfor` and `closedby` through untyped, so these components are where their values are typed.

// The button that opens the dialog `dialog` (its id).
export const DialogOpener: FC<{ dialog: string; class?: string; children?: Child }> = ({
	dialog,
	class: className,
	children,
}) => (
	<button type="button" class={className} command="show-modal" commandfor={dialog}>
		{children}
	</button>
)

// `focus`: where focus lands when it opens. 'heading' focuses the heading row (tabindex="-1" with autofocus), so
// the dialog is announced by its name and no control is chosen for the reader; 'content' leaves it to an autofocus
// inside the children (a form's field). Every dialog also closes on an outside click (closedby="any"): the most it
// loses is a server's domain typed, and one rule for every dialog matters more (docs/web-pages.md).
export const Dialog: FC<{
	id: string
	title: Child
	focus: 'heading' | 'content'
	children?: Child
}> = ({ id, title, focus, children }) => {
	const { m } = useUi()
	const heading = `${id}-title`
	return (
		<dialog id={id} class="card" aria-labelledby={heading} closedby="any">
			<div
				class="dhead"
				tabindex={focus === 'heading' ? -1 : undefined}
				autofocus={focus === 'heading' ? true : undefined}
			>
				<h2 id={heading}>{title}</h2>
				<button type="button" class="btn quiet icon" command="close" commandfor={id}>
					<Icon name="x" size={18} label={m.a11y.close} />
				</button>
			</div>
			{children}
		</dialog>
	)
}

// A post's further actions behind one quiet "Share" button: a popover of buttons, each opening its dialog, with no
// script. It is a group of buttons, not an ARIA menu (no arrow keys); light dismiss, Esc and Tab work as the popover
// gives them. The popover follows its trigger, so it is named by it and anchored to it. Its items are hidden once their
// dialog opens, so the L1 bundle returns focus to the trigger when the dialog closes (src/client/dialogs.ts); without
// script focus leaves the dialog.
export const ActionsMenu: FC<{ id: string; children?: Child }> = ({ id, children }) => {
	const { m } = useUi()
	return (
		<>
			<button type="button" class="btn quiet icon" command="toggle-popover" commandfor={id}>
				{/* The counts row's icon size (16, beside --t1 text). */}
				<Icon name="share" size={16} label={m.post.share} />
			</button>
			<div id={id} popover="auto" class="menu card">
				{children}
			</div>
		</>
	)
}
