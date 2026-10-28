import type { Db } from "../db/sql";
import { isPublicCollection, type Visibility } from "./audience";
import { type EmojiCandidate } from "./custom-emojis";
import { type CardCandidate } from "./link-cards";
import { type RemotePollInput } from "./polls";

// A received status as the federation layer hands it over, and the reads of stored remote statuses that quotes.ts
// shares with remote-statuses.ts. Imports only leaves.

export type RemoteMediaInput = {
  type: "image" | "video" | "audio" | "unknown";
  url: string;
  previewUrl: string | null;
  description: string;
  focus: { x: number; y: number } | null;
  width: number | null;
  height: number | null;
  // media_attachments.blurhash as stored (stored-bounds.ts storedBlurhash).
  blurhash: string | null;
};

// A remote Note (or a converted Article, Page, Image, Audio, Video or Event) as the Worker read it.
export type RemoteStatusInput = {
  uri: string;
  url: string | null;
  attributedTo: string | null;
  // Sanitized HTML (HTML-1), and its text for search.
  content: string;
  text: string;
  spoilerText: string;
  sensitive: boolean;
  language: string | null;
  published: string | null;
  updated: string | null;
  inReplyTo: string | null;
  // The thread the sender names (Mastodon's `conversation`), when it names one.
  conversation?: string | null;
  to: string[];
  cc: string[];
  // hrefs of Mention tags, and normalized names of Hashtag tags.
  mentions: string[];
  tags: string[];
  // Emoji tags as read (federation/remote-emoji.ts); the snapshot is chosen when the status is written.
  emojiTags: EmojiCandidate[];
  media: RemoteMediaInput[];
  // The Note's name (a vote names its choice), and the poll of a Question.
  name?: string | null;
  poll?: RemotePollInput | null;
  // The quote the Note names (quote, _misskey_quote, quoteUrl or quoteUri), or null.
  quote?: RemoteQuoteInput | null;
  // Who the Note's author lets quote it (interactionPolicy.canQuote), or null when it states nothing.
  quotePolicy?: RemoteQuotePolicyInput | null;
  // The content's anchors a link card may take, at most CARD_CANDIDATES, in document order (link-cards.ts).
  cardCandidates?: CardCandidate[];
  // The object as received.
  raw: string;
};

// A quote as StatusParser reads it: the quoted status's uri (null only for a Tombstone without an id), whether the Note
// had no `quote` property (a legacy quote: Misskey's _misskey_quote or quoteUrl, Fedibird's quoteUri), whether the
// quote is a Tombstone (the quoted status is gone), and the stamp (quoteAuthorization) it names.
export type RemoteQuoteInput = {
  uri: string | null;
  legacy: boolean;
  tombstone: boolean;
  approvalUri: string | null;
  // The quoted Note as the quoting Note embeds it (one level, never trusted beyond what recordQuote checks), or null.
  embedded?: RemoteStatusInput | null;
};

// interactionPolicy.canQuote as the Worker read it: the URIs each half lists ('' for an entry that is not one).
export type RemoteQuotePolicyInput = { automatic: string[]; manual: string[] };

export type StoredStatus = {
  id: string;
  account_id: string;
  reblog_of_id: string | null;
  visibility: Visibility;
  content: string;
  spoiler_text: string;
  sensitive: number;
  language: string | null;
  published_at: string;
  edited_at: string | null;
  remote_version: string | null;
};

export function statusByUri(db: Db, uri: string): StoredStatus | undefined {
  return db.first<StoredStatus>(
    `SELECT id, account_id, reblog_of_id, visibility, content, spoiler_text, sensitive, language, published_at, edited_at,
			remote_version
		FROM statuses WHERE uri = ?`,
    uri,
  );
}

// The author's followers collection, as its stored document names it.
export function followersUri(db: Db, accountId: string): string | null {
  return (
    db.first<{ followers: string | null }>(
      `SELECT CASE WHEN json_type(raw, '$.followers') = 'text' THEN json_extract(raw, '$.followers') END AS followers
			FROM accounts WHERE id = ?`,
      accountId,
    )?.followers ?? null
  );
}

// The visibility a fetched original would be stored with (before silent mentions), for VIS-6's check before anything
// is stored: StatusParser#visibility.
export function visibilityOf(input: RemoteStatusInput, followersUri: string | null): Visibility {
  if (input.to.some(isPublicCollection)) {
    return "public";
  }
  if (input.cc.some(isPublicCollection)) {
    return "unlisted";
  }
  return followersUri !== null && input.to.includes(followersUri) ? "private" : "direct";
}
