import type { FC } from 'hono/jsx'

import { DateTime, Rich } from './basics'
import { Dialog } from './dialog'
import { ContentWarning, MediaGrid, PollOptions } from './post'
import { useUi } from '../ui'
import type { HistoryView, VersionView } from '../view/history'

// A status's edit history (design §8 "Edit history", §11 HistoryList): its versions newest first, each labelled and
// dated, with its own warning, content, media and poll choices, and no `lang` (a version records none, §9.5). When
// older versions were left out, the list ends with how many: the one describing text a page shows
// (docs/web-pages.md). The list is bounded by its read and sits in a closed dialog, so it has no content-visibility
// (amendment A7).

// The id of the status page's history dialog, which the post's "Edited" control opens.
export const HISTORY_DIALOG = 'history'

const Version: FC<{ version: VersionView }> = ({ version }) => {
	const { m, f } = useUi()
	const content = (
		<>
			<Rich class="body" html={version.html} />
			<MediaGrid items={version.media} sensitive={version.sensitive} lcp={false} playback />
			{version.choices === null ? null : (
				<PollOptions options={version.choices.map((title) => ({ title, share: null }))} />
			)}
		</>
	)
	return (
		<li class="stack">
			<p class="meta">
				<strong>{m.history[version.label]}</strong>
				<DateTime iso={version.at} text={f.instant(version.at)} local />
			</p>
			{version.cw.length === 0 ? content : <ContentWarning text={version.cw}>{content}</ContentWarning>}
		</li>
	)
}

export const HistoryList: FC<{ history: HistoryView }> = ({ history }) => {
	const { m } = useUi()
	return (
		<>
			{history.versions.length === 0 ? null : (
				<ol class="feed versions" role="list">
					{history.versions.map((version) => (
						<Version version={version} />
					))}
				</ol>
			)}
			{history.leftOut === 0 ? null : <p class="muted">{m.history.olderVersionsLeftOut(history.leftOut)}</p>}
		</>
	)
}

// The status page's history dialog: light dismiss (nothing is typed in it), focus on its heading (amendments A5, A7).
export const HistoryDialog: FC<{ history: HistoryView }> = ({ history }) => {
	const { m } = useUi()
	return (
		<Dialog id={HISTORY_DIALOG} title={m.history.title} focus="heading" lightDismiss>
			<HistoryList history={history} />
		</Dialog>
	)
}
