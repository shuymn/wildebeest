import type { EmojiField, Inline } from './emoji'
import type { Poll } from '../../domain/polls'

// A poll as the pages show it (POLL-2): its choices, and their shares only when the presenter showed each
// choice's count. With `hide_totals` the presenter shows no choice's count until the poll ends, for everyone
// (polls.ts, Poll#show_totals_now?), so nothing here can show one. No page votes.

export type PollOptionView = {
	title: Inline[]
	// The choice's share of the votes (0 to 1), and whether no choice has more; null while the counts are hidden.
	share: { ratio: number; leading: boolean } | null
}

export type PollView = {
	options: PollOptionView[]
	// How many took part: the voters when the poll counts them (a multiple-choice poll), else the votes.
	turnout: { n: number; voters: boolean }
	expired: boolean
	expiresAt: string | null
}

// Each choice's title is a field of its own for the emoji allowance (`field` makes one of the status's emojis, of
// which Poll#emojis is the subset its choices reference). A share is of the voters for a multiple-choice poll that
// counts them, as Mastodon's web client divides, else of the votes; nothing counted shares 0.
export function pollView(poll: Poll, field: () => EmojiField): PollView {
	const shown = poll.options.every((option) => option.votes_count !== null)
	const total = poll.multiple && poll.voters_count !== null ? poll.voters_count : poll.votes_count
	const most = Math.max(0, ...poll.options.map((option) => option.votes_count ?? 0))
	return {
		options: poll.options.map((option) => ({
			title: field().text(option.title),
			share:
				!shown || option.votes_count === null
					? null
					: {
							ratio: total > 0 ? Math.min(1, option.votes_count / total) : 0,
							leading: option.votes_count > 0 && option.votes_count === most,
						},
		})),
		turnout:
			poll.voters_count === null ? { n: poll.votes_count, voters: false } : { n: poll.voters_count, voters: true },
		expired: poll.expired,
		expiresAt: poll.expires_at,
	}
}
