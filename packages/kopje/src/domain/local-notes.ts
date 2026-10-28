import { utf8Length } from "../platform/dump-format";
import { presentedCountSql } from "../platform/stored-bounds";
import {
  PIN_LIMIT,
  statusFacts,
  contextOf,
  noteOf,
  SERVABLE,
  announceActivity,
  boostAnnounce,
  createActivity,
} from "./activities";
import { ANSWER_BYTES } from "./answer-budget";
import { availableLocalSql, availableSql, DISTRIBUTABLE_SQL, type Visibility } from "./audience";
import { readOperation } from "./operation";
import { noteQuote } from "./quotes";
import { readWindow, singleWindow, windowJson } from "./windows";

// A local actor's ActivityPub documents the Worker serves: a status's Note (the object endpoint), the outbox and the
// featured collection. They read each status's quote through quotes.ts (noteQuote), which builds on activities.ts.

// The Note as serialized JSON-LD.
export const getLocalNote = readOperation<{ uri: string }, string | null>((db, { uri }) => {
  const row = db.first<{ id: string }>(
    `SELECT s.id FROM statuses s JOIN local_accounts l ON l.account_id = s.account_id
		WHERE s.uri = ? AND s.reblog_of_id IS NULL AND ${SERVABLE}`,
    uri,
  );
  const facts = row === undefined ? null : statusFacts(db, row.id, noteQuote, { reached: false });
  return facts === null ? null : JSON.stringify({ "@context": contextOf(facts), ...noteOf(facts) });
});

export const OUTBOX_PAGE_SIZE = 20;

// The bytes of an outbox page's serialized activities at most (RES-3): ANSWER_BYTES less a reserve for the
// collection page around them, which the Worker builds. Activities are admitted newest first while they fit, the first
// whatever its size (one Create of a local status, a unit); a page cut there continues from its last activity.
export const OUTBOX_BYTES = ANSWER_BYTES - 64 * 1024;

// Items are serialized JSON: RPC types cannot carry `unknown`.
export type OutboxPage = { total: number | null; items: string[]; next: string | null };

// A local actor's outbox, newest first: Create for its statuses, Announce for its boosts (of public or unlisted
// originals only). before null asks for the count only; otherwise a page of statuses with ids below it. The count is
// the account's stored statuses_count (presentedCountSql), as Mastodon's OutboxesController gives totalItems
// (@account.statuses_count): one row, however long the history.
export const getOutbox = readOperation<{ username: string; before: string | null }, OutboxPage | null>(
  (db, { username, before }) => {
    const owner = db.first<{ id: string; uri: string; statuses_count: number }>(
      `SELECT a.id, a.uri, ${presentedCountSql("a.statuses_count")} AS statuses_count
			FROM accounts a JOIN local_accounts l ON l.account_id = a.id
			WHERE a.domain IS NULL AND lower(a.username) = lower(?1) AND a.username = ?1 AND ${availableLocalSql("l")}`,
      username,
    );
    if (owner === undefined) {
      return null;
    }
    const listed = `FROM statuses s JOIN local_accounts l ON l.account_id = s.account_id
			LEFT JOIN statuses o ON o.id = s.reblog_of_id
			WHERE s.account_id = ?1 AND ${SERVABLE}
				AND (s.reblog_of_id IS NULL OR (o.visibility IN ${DISTRIBUTABLE_SQL} AND ${availableSql("o.account_id")}))`;
    // The count only for the collection itself; a page does not need it.
    if (before === null) {
      return { total: owner.statuses_count, items: [], next: null };
    }
    // A statuses_account window (windows.ts) below `before`: public and unlisted statuses and boosts of such
    // originals, then the rule, so unavailable originals cost a window. Statuses an anonymous reader may not see
    // supply no cursor (docs/visibility.md "Read bounds"). One more than a page tells whether more follow.
    const size = readWindow(OUTBOX_PAGE_SIZE + 1);
    const window = singleWindow(
      db,
      `SELECT s.id FROM statuses s WHERE s.account_id = ?1 AND s.id < ?2 AND s.visibility IN ${DISTRIBUTABLE_SQL}
				AND (s.reblog_of_id IS NULL OR EXISTS (SELECT 1 FROM statuses wo
					WHERE wo.id = s.reblog_of_id AND wo.visibility IN ${DISTRIBUTABLE_SQL}))
			ORDER BY s.id DESC LIMIT ?3`,
      size,
      owner.id,
      before,
      size,
    );
    const rows =
      window.candidates.length === 0
        ? []
        : db.all<{
            id: string;
            uri: string;
            visibility: Visibility;
            published_at: string;
            original_id: string | null;
            original_uri: string | null;
            original_author_id: string | null;
            original_author_uri: string | null;
          }>(
            `SELECT s.id, s.uri, s.visibility, s.published_at, o.id AS original_id, o.uri AS original_uri,
							o.account_id AS original_author_id, (SELECT uri FROM accounts WHERE id = o.account_id) AS original_author_uri
						${listed} AND s.id IN (SELECT json_extract(value, '$.id') FROM json_each(?2)) ORDER BY s.id DESC`,
            owner.id,
            windowJson(window),
          );
    const items: string[] = [];
    let bytes = 0;
    let consumed = 0;
    const admitted = (item: string): boolean => {
      const size = utf8Length(item) + 1;
      if (bytes + size > OUTBOX_BYTES && items.length > 0) {
        return false;
      }
      bytes += size;
      items.push(item);
      return true;
    };
    for (const row of rows.slice(0, OUTBOX_PAGE_SIZE)) {
      if (row.original_uri !== null && row.original_author_uri !== null && row.original_author_id !== null) {
        const announce = admitted(
          JSON.stringify(
            announceActivity(
              boostAnnounce(
                db,
                owner.id,
                {
                  announceUri: row.uri,
                  actorUri: owner.uri,
                  visibility: row.visibility,
                  publishedAt: row.published_at,
                  objectUri: row.original_uri,
                },
                { id: row.original_author_id, uri: row.original_author_uri },
                "content",
              ),
            ).activity,
          ),
        );
        if (!announce) {
          break;
        }
        consumed++;
        continue;
      }
      const facts = statusFacts(db, row.id, noteQuote, { reached: false });
      if (facts !== null && !admitted(JSON.stringify(createActivity(facts).activity))) {
        break;
      }
      consumed++;
    }
    const last = rows[OUTBOX_PAGE_SIZE - 1];
    // Cut by bytes, the page continues from its last activity, before the window's continuation.
    const next =
      consumed < Math.min(rows.length, OUTBOX_PAGE_SIZE)
        ? (rows[consumed - 1]?.id ?? null)
        : rows.length > OUTBOX_PAGE_SIZE && last !== undefined
          ? last.id
          : window.cut
            ? (window.candidates.at(-1)?.id ?? null)
            : null;
    return { total: null, items, next };
  },
);

// A pinned status in the featured collection: the Note (serialized JSON-LD) of a public or unlisted one, else its uri
// alone (ActivityPub::CollectionsController#set_items: `item.distributable? ? item : uri`).
export type FeaturedItem = { uri: string; note: string | null };

// A local actor's featured collection (ActivityPub::CollectionsController, `featured`): its pinned statuses, newest pin
// first (Account#pinned_statuses), all at once (an OrderedCollection without pages). Null for no such actor, or a
// suspended one, as the outbox answers. The actor is found through the index of local usernames, and its pins through
// their primary key: at most PIN_LIMIT.
export const getFeatured = readOperation<{ username: string }, FeaturedItem[] | null>((db, { username }) => {
  const owner = db.first<{ id: string }>(
    `SELECT a.id FROM accounts a JOIN local_accounts l ON l.account_id = a.id
		WHERE a.domain IS NULL AND lower(a.username) = lower(?1) AND a.username = ?1 AND ${availableLocalSql("l")}`,
    username,
  );
  if (owner === undefined) {
    return null;
  }
  const rows = db.all<{ id: string; uri: string; servable: number }>(
    `SELECT s.id, s.uri, s.visibility IN ${DISTRIBUTABLE_SQL} AS servable
		FROM status_pins p CROSS JOIN statuses s ON s.id = p.status_id
		WHERE p.account_id = ?1 AND s.account_id = ?1 AND s.reblog_of_id IS NULL
		ORDER BY p.created_at DESC, s.id DESC LIMIT ?2`,
    owner.id,
    PIN_LIMIT,
  );
  // The Notes within OUTBOX_BYTES (RES-3), in pin order, the first whatever its size; from the first that does not
  // fit, each pin is shown by its uri alone, as a pin that is not distributable is, and a receiver fetches it.
  let bytes = 0;
  let full = false;
  return rows.map((row) => {
    const facts = row.servable === 1 && !full ? statusFacts(db, row.id, noteQuote, { reached: false }) : null;
    const note = facts === null ? null : JSON.stringify({ "@context": contextOf(facts), ...noteOf(facts) });
    const size = note === null ? 0 : utf8Length(note) + 1;
    if (note !== null && bytes > 0 && bytes + size > OUTBOX_BYTES) {
      full = true;
    }
    if (note === null || full) {
      return { uri: row.uri, note: null };
    }
    bytes += size;
    return { uri: row.uri, note };
  });
});
