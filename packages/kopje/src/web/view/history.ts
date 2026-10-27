import { type EmojiAllowance, emojiFields, type Inline } from './emoji'
import { type MediaView, mediaView } from './media'
import type { PageHistory } from '../../domain/web-pages/status'
import { type SafeHtml, sanitizedWithEmoji } from '../safe-html'

// A status's edit history as its page shows it. Pure: the read decided which versions fit (domain/web-pages/status.ts).

// `current`: the newest version, the status as it is; `original`: the first version, shown only when no older one
// was left out; `edited`: any other.
export type VersionLabel = 'current' | 'edited' | 'original'

// One version with its own warning, sensitive flag, media and poll choices. No `lang`: a version records no language.
export type VersionView = {
	label: VersionLabel
	at: string
	cw: Inline[]
	html: SafeHtml
	media: MediaView[]
	sensitive: boolean
	choices: Inline[][] | null
}

export type HistoryView = { versions: VersionView[]; leftOut: number }

// The versions newest first, each with its own emoji snapshot, charged to the page's allowance in document order
// (the dialog follows the post): its warning, its content, then its choices. Content is sanitized at the sink (HTML-1).
export function historyView(history: PageHistory, domain: string, allowance: EmojiAllowance): HistoryView {
	const last = history.versions.length - 1
	return {
		versions: history.versions.map((version, index) => {
			const field = emojiFields(version.emojis, allowance)
			const cw = version.spoiler_text === '' ? [] : field().text(version.spoiler_text)
			const html = sanitizedWithEmoji(version.content, field())
			return {
				label: index === 0 ? 'current' : index === last && history.leftOut === 0 ? 'original' : 'edited',
				at: version.created_at,
				cw,
				html,
				media: version.media_attachments.flatMap((media) => mediaView(media, domain) ?? []),
				sensitive: version.sensitive,
				choices: version.poll === null ? null : version.poll.options.map(({ title }) => field().text(title)),
			}
		}),
		leftOut: history.leftOut,
	}
}
