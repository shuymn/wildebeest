import { type JSXNode } from "hono/jsx";

import type { Account } from "../src/domain/accounts";
import type { Poll } from "../src/domain/polls";
import type { MediaAttachment, Status } from "../src/domain/status-presenter";
import type { Site } from "../src/domain/web-pages/site";

// Presented values for rendering the web components directly (view data, as the page reads return it), for the
// contracts a stored row cannot reach: values the stored bounds would refuse, at the sink. The pages render them as
// the Worker does (c.html writes the element as it is).

export const DOMAIN = "kopje.test";
export const ORIGIN = `https://${DOMAIN}`;
export const SITE: Site = { domain: DOMAIN, documents: { privacyPolicy: false, termsOfService: false } };

export const CREATED = "2026-10-20T09:30:00.000Z";

export function account(fields: Partial<Account> = {}): Account {
  return {
    id: "1",
    username: "alice",
    acct: "alice",
    display_name: "Alice",
    locked: false,
    bot: false,
    discoverable: true,
    indexable: false,
    group: false,
    created_at: CREATED,
    note: "",
    url: `${ORIGIN}/@alice`,
    uri: `${ORIGIN}/users/alice`,
    avatar: `${ORIGIN}/assets/avatar.jpg`,
    avatar_static: `${ORIGIN}/assets/avatar.jpg`,
    header: `${ORIGIN}/assets/header.jpg`,
    header_static: `${ORIGIN}/assets/header.jpg`,
    followers_count: 0,
    following_count: 0,
    statuses_count: 0,
    last_status_at: "2026-10-20",
    hide_collections: false,
    emojis: [],
    fields: [],
    ...fields,
  };
}

export function status(id: string, fields: Partial<Status> = {}): Status {
  return {
    id,
    created_at: CREATED,
    in_reply_to_id: null,
    in_reply_to_account_id: null,
    sensitive: false,
    spoiler_text: "",
    visibility: "public",
    language: "en",
    uri: `${ORIGIN}/users/alice/statuses/${id}`,
    url: `${ORIGIN}/@alice/${id}`,
    replies_count: 0,
    reblogs_count: 0,
    favourites_count: 0,
    quotes_count: 0,
    edited_at: null,
    content: "<p>A post.</p>",
    reblog: null,
    account: account(),
    media_attachments: [],
    mentions: [],
    tags: [],
    emojis: [],
    quote: null,
    quote_approval: { automatic: ["public"], manual: [], current_user: "unknown" },
    card: null,
    poll: null,
    ...fields,
  };
}

export function media(id: string, fields: Partial<MediaAttachment> = {}): MediaAttachment {
  return {
    id,
    type: "image",
    url: `${ORIGIN}/media/${id}/full.png`,
    preview_url: `${ORIGIN}/media/${id}/small.png`,
    remote_url: null,
    preview_remote_url: null,
    text_url: null,
    meta: { small: { width: 640, height: 360, size: "640x360", aspect: 640 / 360 } },
    description: `Attachment ${id}`,
    blurhash: null,
    ...fields,
  };
}

export function poll(fields: Partial<Poll> = {}): Poll {
  return {
    id: "1",
    expires_at: "2026-10-30T00:00:00.000Z",
    expired: false,
    multiple: false,
    votes_count: 10,
    voters_count: 10,
    options: [
      { title: "Yes", votes_count: 7 },
      { title: "No", votes_count: 3 },
    ],
    emojis: [],
    ...fields,
  };
}

export { customEmoji } from "./emoji-fixtures";

// The bytes a page component renders to.
export async function render(node: unknown): Promise<string> {
  return String(await (node as JSXNode).toString());
}
