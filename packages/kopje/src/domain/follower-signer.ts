import type { Db } from "../db/sql";
import { availableLocalSql } from "./audience";

// A local account whose key signs a fetch on a remote account's behalf (DATA-7): `follower` follows `of`. Both are
// account ids, so choosing the signer checks the follow and the follower's standing again (fetchSignerOf in actors.ts)
// rather than trusting a name.
export type FollowerSigner = { follower: string; of: string };

// The first available local account that follows the account (Mastodon's local_follower), or null. Walked from the
// local accounts, each a key lookup of its follow: the account's remote followers, however many, are never read.
export function localFollower(db: Db, accountId: string): FollowerSigner | null {
  const row = db.first<{ id: string }>(
    `SELECT l.account_id AS id FROM local_accounts l
		WHERE ${availableLocalSql("l")} AND EXISTS (SELECT 1 FROM follows f
			WHERE f.account_id = l.account_id AND f.target_account_id = ? AND f.state = 'accepted')
		ORDER BY l.account_id LIMIT 1`,
    accountId,
  );
  return row === undefined ? null : { follower: row.id, of: accountId };
}
