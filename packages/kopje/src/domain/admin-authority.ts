import { type ColumnMap, rowHeapSql, selectSql } from "../db/columns";
import { ACCOUNTS_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { ACCESS_SETTINGS, accessRefusal, settingsFromRows, type SettingRow } from "../platform/access-settings";
import { loginEmailMatchSql } from "../platform/login-email";
import type { ImportAuthority } from "../platform/store-admin";
import { readOperation } from "./operation";

// The Access admin, checked against the saved configuration, as the Worker verified it, in the transaction of an admin
// operation that writes (the media rebuild, the key rewrap). IMPORT_TOKEN and import sessions are refused with
// `refusal`: these operations run through Access only. null when the admin may go on.
export function accessAdminRefusal(db: Db, authority: ImportAuthority, refusal: string): string | null {
  if (authority.kind !== "access") {
    return refusal;
  }
  const names = Object.values(ACCESS_SETTINGS);
  const rows = db.all<SettingRow>(
    `SELECT name, value FROM instance_settings WHERE name IN (${names.map(() => "?").join(",")})`,
    ...names,
  );
  return accessRefusal(settingsFromRows(rows), authority);
}

// Why there is, or is not, an OAuth admin:
//   ok        exactly one local account's email matches admin_email, and it is not suspended
//   unset     admin_email is missing or empty
//   none      no local account's email matches
//   suspended the one match is suspended
//   ambiguous two or more local accounts match (local_accounts.email is unique only byte for byte)
export type OAuthAdminStatus = "ok" | "unset" | "none" | "suspended" | "ambiguous";

export type OAuthAdmin = {
  status: OAuthAdminStatus;
  // The matched account's username (ok, suspended); null otherwise, so nothing is picked when the match is ambiguous.
  username: string | null;
  // The admin's account id, only when status is ok.
  accountId: string | null;
};

// oauthAdmin's two reads by the maps their columns come from, which also give their row heap (OAUTH_ADMIN_HEAP_SQL):
// admin_email's setting row, and the local accounts whose email matches it (compared in SQL, so the email is not read),
// with their usernames. Each account is sought by its key from the local scan, so statistics older than the Store's
// growth cannot make the read a scan of accounts (RES-7).
export const ADMIN_EMAIL_COLUMNS = { value: "i.value" } as const satisfies ColumnMap;
const ADMIN_EMAIL_FROM = "instance_settings i";
export const LOCAL_EMAIL_COLUMNS = {
  account_id: "l.account_id",
  username: "a.username",
  suspended_at: "l.suspended_at",
} as const satisfies ColumnMap;
const LOCAL_EMAIL_FROM = `local_accounts l CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = l.account_id`;

// The row heap (rowHeapSql) oauthAdmin reads at most, as one SQL expression: the setting row, and every local account's
// row (of which it reads at most two, the matches) unless admin_email is missing or '' (a value only JavaScript's trim()
// blanks counts, so it never undercounts).
// Presentation reads it at most once per operation (adminAccountIdOnce), which status-rows.ts counts for each item
// containing a local author.
export const OAUTH_ADMIN_HEAP_SQL = `(coalesce((SELECT ${rowHeapSql(ADMIN_EMAIL_COLUMNS)} FROM ${ADMIN_EMAIL_FROM}
		WHERE i.name = '${ACCESS_SETTINGS.adminEmail}'), 0)
	+ CASE WHEN EXISTS (SELECT 1 FROM ${ADMIN_EMAIL_FROM}
			WHERE i.name = '${ACCESS_SETTINGS.adminEmail}' AND i.value <> '')
		THEN coalesce((SELECT sum(${rowHeapSql(LOCAL_EMAIL_COLUMNS)}) FROM ${LOCAL_EMAIL_FROM}), 0) ELSE 0 END)`;

// OAuth admin for the Mastodon API and post-bootstrap setup; see OAuthAdminStatus for fail-closed outcomes.
// admin_email names local accounts by the sign-in's rule (login-email.ts loginEmailMatchSql, AUTH-9), in SQL, so the admin
// is an account its Access identity signs in to; a blank admin_email is unset before any match. Re-read in each
// operation's transaction so tokens follow changes. Full local_accounts scan assumes an operator-sized deployment
// (about 10 accounts).
export function oauthAdmin(db: Db): OAuthAdmin {
  const email = db.first<{ value: string }>(
    `SELECT ${selectSql(ADMIN_EMAIL_COLUMNS)} FROM ${ADMIN_EMAIL_FROM} WHERE i.name = ?`,
    ACCESS_SETTINGS.adminEmail,
  )?.value;
  if (email === undefined || email.trim() === "") {
    return { status: "unset", username: null, accountId: null };
  }
  const rows = db.all<{ account_id: string; username: string; suspended_at: string | null }>(
    `SELECT ${selectSql(LOCAL_EMAIL_COLUMNS)} FROM ${LOCAL_EMAIL_FROM} WHERE ${loginEmailMatchSql("l.email")} LIMIT 2`,
    email,
  );
  const [row] = rows;
  if (row === undefined) {
    return { status: "none", username: null, accountId: null };
  }
  if (rows.length > 1) {
    return { status: "ambiguous", username: null, accountId: null };
  }
  if (row.suspended_at !== null) {
    return { status: "suspended", username: row.username, accountId: null };
  }
  return { status: "ok", username: row.username, accountId: row.account_id };
}

export function adminAccountId(db: Db): string | null {
  return oauthAdmin(db).accountId;
}

const onceByDb = new WeakMap<Db, string | null>();

// adminAccountId read once per operation until forgotten, null included: each operation runs on its own Db in one
// transaction (operation.ts), and its metered views share its root (sql.ts), so one lookup serves the whole operation
// (R37's admin.report reads, pushes, the Owner role of presented accounts). A writer of what the match reads
// (admin_email, a local account's email or suspension) forgets it right after its write in the same operation:
// setAccountEmail, suspendLocal, unsuspendLocal and bootstrapInstance. StoreAdmin.setConfig, import and reset,
// migrations and the cutover write with no operation Db that outlives the write, so they need not.
export function adminAccountIdOnce(db: Db): string | null {
  if (!onceByDb.has(db.root)) {
    onceByDb.set(db.root, adminAccountId(db));
  }
  return onceByDb.get(db.root) ?? null;
}

// After a write that may change the OAuth admin, so the operation's next adminAccountIdOnce reads it again.
export function forgetAdminAccountId(db: Db): void {
  onceByDb.delete(db.root);
}

// The OAuth admin's state for GET /admin/health (Access only), so the operator sees why there is no admin.
export const oauthAdminStatus = readOperation<void, Omit<OAuthAdmin, "accountId">>((db) => {
  const { status, username } = oauthAdmin(db);
  return { status, username };
});
