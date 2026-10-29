import { ACCOUNTS_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { loginEmailMatchSql, sqliteLower } from "../platform/login-email";
import type { ImportAuthority } from "../platform/store-admin";
import { storedWarningText, WARNING_TEXT_BYTES } from "../platform/stored-bounds";
import { writeAccountWarning } from "./account-warnings";
import type { Page, PageQuery, Present } from "./accounts";
import { type AdminAccount, adminAccountStream } from "./admin-account-presenter";
import { accessAdminRefusal, forgetAdminAccountId } from "./admin-authority";
import { admit, ARRAY_ANSWER_BYTES } from "./answer-budget";
import { activeSql, availableJoinedSql, availableLocalSql, deletingSql, suspendedSql } from "./audience";
import {
  ADMIN_PERMISSION,
  adminGuarded,
  adminReadOperation,
  adminWriteOperation,
  EVERYONE_ROLE,
  OWNER_ROLE,
} from "./auth";
import { logAction } from "./moderation-log";
import { notify } from "./notifications";
import { writeOperation } from "./operation";
import { domainJobRunning, suspendRemote, unsuspendRemote } from "./remote-suspension";
import { reportStatusIds, resolveReport } from "./reports";
import { suspendLocal, unsuspendLocal } from "./suspension";

// Accounts as the Mastodon admin API shows them to the OAuth admin (R37): their entity, the list and its filters, an
// account by id and the actions that change nothing; and the Access admin's repair of the OAuth admin's match.

// One admin entity, a unit (RES-2); undefined for an id with no account.
function presentAdminAccount(db: Db, id: string, adminId: string, present: Present): AdminAccount | undefined {
  return adminAccountStream(db, [id], adminId, present, 1).next().value;
}

// The longest email set-email takes (RFC 5321's path limit).
const MAX_EMAIL_LENGTH = 254;

export type SetEmailResult =
  | { ok: true; username: string; email: string }
  | { ok: false; code: "wrong-authority" | "account-not-found" | "invalid-email" | "email-taken"; message: string };

// POST /admin/accounts/email (`kopje-admin account set-email`), Access only (AUTH-5): sets a local account's email,
// trimmed, which signs it in through Access and makes it the OAuth admin when it alone matches admin_email (VIS-29).
// It is how the operator repairs an admin match that is missing or ambiguous. An email that another local account's
// matches by the sign-in's rule (login-email.ts loginEmailMatchSql, which the OAuth admin's match uses too) is refused, so
// the repair never makes a match ambiguous. Logged in the moderation log with the Access identity, in the same
// transaction.
export const setAccountEmail = writeOperation<
  { authority: ImportAuthority; username: string; email: string; now: number },
  SetEmailResult
>((db, { authority, username, email, now }) => {
  const refused = accessAdminRefusal(db, authority, "only an Access admin sets an account email");
  if (refused !== null || authority.kind !== "access") {
    return { ok: false, code: "wrong-authority", message: refused ?? "only an Access admin sets an account email" };
  }
  const account = db.first<{ id: string; username: string }>(
    "SELECT a.id, a.username FROM accounts a JOIN local_accounts l ON l.account_id = a.id WHERE lower(a.username) = lower(?) AND a.domain IS NULL",
    username.replace(/^@/, ""),
  );
  if (account === undefined) {
    return { ok: false, code: "account-not-found", message: `no local account @${username.replace(/^@/, "")}` };
  }
  const value = email.trim();
  if (value === "" || value.length > MAX_EMAIL_LENGTH || !/^[^\s@]+@[^\s@]+$/u.test(value)) {
    return { ok: false, code: "invalid-email", message: "expected an email address" };
  }
  // A scan of local_accounts (no index serves lower(email)), operator-sized (a deployment assumption of about 10
  // accounts), as the admin match reads it.
  const taken = db.first(
    `SELECT 1 AS found FROM local_accounts WHERE account_id != ? AND ${loginEmailMatchSql("email")} LIMIT 1`,
    account.id,
    value,
  );
  if (taken !== undefined) {
    return { ok: false, code: "email-taken", message: "another local account has this email" };
  }
  db.run("UPDATE local_accounts SET email = ? WHERE account_id = ?", value, account.id);
  forgetAdminAccountId(db);
  logAction(db, authority, "change_email", { type: "Account", id: account.id }, { username: account.username }, now);
  return { ok: true, username: account.username, email: value };
});

export type UnsuspendResult =
  | { ok: true; username: string }
  | { ok: false; code: "wrong-authority" | "account-not-found" | "not-suspended"; message: string };

// POST /admin/accounts/unsuspend (`kopje-admin account unsuspend`), Access only (AUTH-5): unsuspends a local account as
// the admin API does (domain/suspension.ts unsuspendLocal; its credential epoch stays). It is how the operator
// recovers a suspended OAuth admin, whom no OAuth admin can unsuspend. Logged in the moderation log with the Access
// identity, in the same transaction.
export const unsuspendAccount = writeOperation<
  { authority: ImportAuthority; username: string; now: number },
  UnsuspendResult
>((db, { authority, username, now }) => {
  const refused = accessAdminRefusal(db, authority, "only an Access admin unsuspends an account");
  if (refused !== null || authority.kind !== "access") {
    return { ok: false, code: "wrong-authority", message: refused ?? "only an Access admin unsuspends an account" };
  }
  const name = username.replace(/^@/, "");
  const account = db.first<{ id: string; username: string }>(
    "SELECT a.id, a.username FROM accounts a JOIN local_accounts l ON l.account_id = a.id WHERE lower(a.username) = lower(?) AND a.domain IS NULL",
    name,
  );
  if (account === undefined) {
    return { ok: false, code: "account-not-found", message: `no local account @${name}` };
  }
  if (!unsuspendLocal(db, account.id, now)) {
    return { ok: false, code: "not-suspended", message: `@${account.username} is not suspended` };
  }
  logAction(db, authority, "unsuspend", { type: "Account", id: account.id }, { username: account.username }, now);
  return { ok: true, username: account.username };
});

// ---- The admin's accounts (Api::V1::Admin::AccountsController and Api::V2::Admin::AccountsController, app/controllers/
// api/v{1,2}/admin/accounts_controller.rb; AccountFilter, app/models/account_filter.rb; Api::V1::Admin::
// AccountActionsController and Admin::AccountAction). The routes need manage_users. adminAccountOperations builds them
// over any admin guard (adminReadOperation and adminWriteOperation outside tests).

export const ADMIN_ACCOUNTS_LIMIT = 100;
export const MAX_ADMIN_ACCOUNTS_LIMIT = 200;
// The most candidates a search reads (a username, display name or domain range); one more is read to see that there
// are more, which answers 'too_broad' rather than a page out of id order or an empty one.
export const ADMIN_ACCOUNT_CANDIDATES = 2_000;

export type AdminAccountStatus = "active" | "pending" | "disabled" | "silenced" | "suspended" | "sensitized";

// AccountFilter's keys after the controller's translation (mastodon/admin.ts maps both versions' names); null if unsent
// or blank (AccountFilter skips blanks). Values as AccountFilter reads them: by_domain/display_name/email trimmed,
// username stripped of spaces and a leading @, by_domain lowercased (Kopje stores domains so). roleIds: '3' = OAuth
// admin (Owner), '-99' = other locals (everyone); staff and permissions=staff become ['3'], the manage_reports role.
export type AdminAccountFilter = {
  origin: "local" | "remote" | null;
  status: AdminAccountStatus | null;
  roleIds: readonly string[] | null;
  username: string | null;
  byDomain: string | null;
  displayName: string | null;
  email: string | null;
  ip: string | null;
  invitedBy: string | null;
};

export type AdminAccountList =
  | ({ status: "ok"; more: boolean } & Page<AdminAccount>)
  // More than ADMIN_ACCOUNT_CANDIDATES accounts in the searched range: 422, never an unordered or empty page.
  | { status: "too_broad" }
  // A list of active or suspended accounts while the domain job runs: 503 with Retry-After, never a short or empty
  // page (R38).
  | { status: "moderating" };

// What a filter reads of an account: its id and flags only. unavailable is R1's rule (availableSql): a suspended
// account, local or remote (R38), or a remote one whose deletion has started; the admin entity shows each as
// suspended, and the filter agrees. No text is read (a converted row may keep legacy's username or display name, of
// any length, RES-2): the filter's text predicates are evaluated in SQL (textMatches).
type Candidate = {
  id: string;
  local: number;
  unavailable: number;
};

const CANDIDATE_COLUMNS = `a.id, a.domain IS NULL AS local, NOT ${availableJoinedSql("a", "l")} AS unavailable`;

// The least string above every string that starts with `prefix`, in SQLite's BINARY order (UTF-8 bytes, which is code
// point order): the prefix with its last code point incremented, null when every code point is the highest.
function prefixEnd(prefix: string): string | null {
  const points = [...prefix].map((point) => point.codePointAt(0)!);
  while (points.length > 0) {
    const last = points.pop()!;
    if (last < 0x10ffff) {
      points.push(last + 1 === 0xd800 ? 0xe000 : last + 1);
      return String.fromCodePoint(...points);
    }
  }
  return null;
}

// The roles that match nothing in Kopje: every local account has one of '3' and '-99', and a remote account none.
function noRole(roleIds: readonly string[]): boolean {
  return !roleIds.includes(OWNER_ROLE.id) && !roleIds.includes(EVERYONE_ROLE.id);
}

// Whether no account can match, so the list answers [] without reading: no account is pending, disabled, silenced or
// sensitized, Kopje records no IPs and no invites, and every local account's role is Owner or everyone.
function matchesNothing(filter: AdminAccountFilter): boolean {
  return (
    (filter.status !== null && filter.status !== "active" && filter.status !== "suspended") ||
    filter.ip !== null ||
    filter.invitedBy !== null ||
    (filter.roleIds !== null && noRole(filter.roleIds))
  );
}

// AccountFilter's scopes over an account the plan read: its flags in memory, and `texts`, the candidates whose
// username, domain, display name and email pass the filter's text predicates (textMatches), when it has any.
function matches(
  filter: AdminAccountFilter,
  adminId: string,
  row: Candidate,
  texts: ReadonlySet<string> | null,
): boolean {
  const local = row.local === 1;
  return (
    (filter.origin === null || (filter.origin === "local") === local) &&
    (filter.status === null ||
      (filter.status === "active" && row.unavailable === 0) ||
      (filter.status === "suspended" && row.unavailable === 1)) &&
    (filter.roleIds === null ||
      (local && filter.roleIds.includes(row.id === adminId ? OWNER_ROLE.id : EVERYONE_ROLE.id))) &&
    (texts === null || texts.has(row.id))
  );
}

// A cursor as an 18-digit account id (ids are 18 digits, so their text order is their number order): an upper bound
// above every id is no bound, a lower one is the highest id.
function idBound(cursor: string | undefined, upper: boolean): string | null {
  if (cursor === undefined) {
    return null;
  }
  if (BigInt(cursor) > 999_999_999_999_999_999n) {
    return upper ? null : "999999999999999999";
  }
  return cursor.padStart(18, "0").slice(-18);
}

type Bounds = { max: string | null; min: string | null; ascending: boolean };

function boundsOf(page: PageQuery): Bounds {
  return {
    max: idBound(page.maxId, true),
    min: idBound(page.minId ?? page.sinceId, false),
    ascending: page.minId !== undefined,
  };
}

const inBounds = (bounds: Bounds, id: string) =>
  (bounds.max === null || id < bounds.max) && (bounds.min === null || id > bounds.min);

// A complete set's matches inside the cursor, in the page's order.
function ordered(
  db: Db,
  rows: readonly Candidate[],
  filter: AdminAccountFilter,
  adminId: string,
  bounds: Bounds,
): Candidate[] {
  const texts = textMatches(db, rows, filter);
  return rows
    .filter((row) => inBounds(bounds, row.id) && matches(filter, adminId, row, texts))
    .toSorted((a, b) => (a.id < b.id === bounds.ascending ? -1 : 1));
}

// The candidates that pass the filter's text predicates, tested in SQL so no text is read into the isolate (null when
// it has none): the username, display name and email start with the filter's (ASCII letters folded on both sides,
// as sqliteLower and SQLite's lower() fold alike), each the range from the prefix to its successor in BINARY order
// that searchRange reads; by_domain equals the domain.
function textMatches(db: Db, rows: readonly Candidate[], filter: AdminAccountFilter): Set<string> | null {
  const conditions: string[] = [];
  const values: SqlStorageValue[] = [JSON.stringify(rows.map((row) => row.id))];
  const prefix = (expression: string, value: string | null) => {
    if (value !== null) {
      const range = prefixRange(expression, value, values.length + 1);
      conditions.push(range.where);
      values.push(...range.values);
    }
  };
  prefix("lower(a.username)", filter.username);
  prefix("lower(a.display_name)", filter.displayName);
  prefix("lower(l.email)", filter.email);
  if (filter.byDomain !== null) {
    values.push(filter.byDomain);
    conditions.push(`a.domain = ?${values.length}`);
  }
  if (conditions.length === 0) {
    return null;
  }
  const found = db.all<{ id: string }>(
    `SELECT a.id FROM json_each(?1) c CROSS JOIN accounts a ON a.id = c.value
			LEFT JOIN local_accounts l ON l.account_id = a.id
		WHERE ${conditions.join(" AND ")}`,
    ...values,
  );
  return new Set(found.map((row) => row.id));
}

// The values of `expression` that start with `value` (ASCII letters folded): the range from the folded prefix to its
// successor (prefixEnd) in BINARY order, none above when it has none, with its parameters numbered from `at`.
function prefixRange(expression: string, value: string, at: number): { where: string; values: string[] } {
  const lower = sqliteLower(value);
  const end = prefixEnd(lower);
  return {
    where: `${expression} >= ?${at}${end === null ? "" : ` AND ${expression} < ?${at + 1}`}`,
    values: end === null ? [lower] : [lower, end],
  };
}

// The range of an id walk inside the cursor, for a query whose ?1 and ?2 are the bounds.
const ID_RANGE = "a.id < coalesce(?1, char(58)) AND a.id > coalesce(?2, char(47))";

// The plan's matches inside the cursor, in the page's order: all of them, or at least limit + 1 when there are more;
// 'too_broad' when a search range holds more than ADMIN_ACCOUNT_CANDIDATES accounts. The first rule that applies
// drives the read; the other filters are applied to what it read.
function readMatches(
  db: Db,
  filter: AdminAccountFilter,
  adminId: string,
  bounds: Bounds,
  limit: number,
): Candidate[] | "too_broad" | "moderating" {
  if (filter.origin === "local" || filter.email !== null || filter.roleIds !== null) {
    // The local accounts, an operator-sized set (a deployment assumption of about 10 accounts).
    return ordered(
      db,
      db.all<Candidate>(`SELECT ${CANDIDATE_COLUMNS} FROM local_accounts l JOIN accounts a ON a.id = l.account_id`),
      filter,
      adminId,
      bounds,
    );
  }
  const search = searchRange(filter);
  if (search !== null) {
    const rows = db.all<Candidate>(
      `SELECT ${CANDIDATE_COLUMNS} FROM accounts a INDEXED BY ${search.index}
			LEFT JOIN local_accounts l ON l.account_id = a.id
			WHERE ${search.where} LIMIT ${ADMIN_ACCOUNT_CANDIDATES + 1}`,
      ...search.values,
    );
    return rows.length > ADMIN_ACCOUNT_CANDIDATES ? "too_broad" : ordered(db, rows, filter, adminId, bounds);
  }
  const order = bounds.ascending ? "ASC" : "DESC";
  // The plans below walk indexes that read the domain marks (accounts_suspended, accounts_active), which lag the
  // blocks while the domain job runs (R38, remote-suspension.ts): no page is answered from them meanwhile.
  if ((filter.status === "suspended" || filter.status === "active") && domainJobRunning(db)) {
    return "moderating";
  }
  if (filter.status === "suspended") {
    // The suspended local accounts (operator-sized), and the remote accounts the instance suspended or whose deletion
    // has started, as one range of accounts_suspended and one of accounts_deleted in id order; merged by id.
    const local = db.all<Candidate>(
      `SELECT ${CANDIDATE_COLUMNS} FROM local_accounts l JOIN accounts a ON a.id = l.account_id
			WHERE NOT ${availableLocalSql("l")}`,
    );
    const range = (index: string, where: string) =>
      db.all<Candidate>(
        `SELECT ${CANDIDATE_COLUMNS} FROM accounts a INDEXED BY ${index}
				LEFT JOIN local_accounts l ON l.account_id = a.id
				WHERE ${where} AND ${ID_RANGE} ORDER BY a.id ${order} LIMIT ?3`,
        bounds.max,
        bounds.min,
        limit + 1,
      );
    const remote = [...range("accounts_suspended", suspendedSql("a")), ...range("accounts_deleted", deletingSql("a"))];
    const merged = new Map([...local, ...remote].map((row) => [row.id, row]));
    return ordered(db, [...merged.values()], filter, adminId, bounds).slice(0, limit + 1);
  }
  // No search: the accounts by id, newest first. Active accounts walk accounts_active (migration
  // 0045_remote_suspension), which holds no account suspended by the instance or whose deletion has started, so the
  // walk skips only the suspended local accounts; others walk the primary key. The residual skips the local accounts
  // (remote) and the suspended local accounts (active), operator-sized sets: once the domain job has run, every
  // account a block covers is marked or individually suspended, so none is in accounts_active.
  const active = filter.status === "active";
  const residual = [
    filter.origin === "remote" ? "a.domain IS NOT NULL" : "1",
    active ? `${activeSql("a")} AND ${availableJoinedSql("a", "l")}` : "1",
  ].join(" AND ");
  return db.all<Candidate>(
    `SELECT ${CANDIDATE_COLUMNS} FROM accounts a INDEXED BY ${active ? "accounts_active" : ACCOUNTS_ID_INDEX}
		LEFT JOIN local_accounts l ON l.account_id = a.id
		WHERE ${ID_RANGE} AND ${residual} ORDER BY a.id ${order} LIMIT ?3`,
    bounds.max,
    bounds.min,
    limit + 1,
  );
}

// The index range a search reads, or null when the filter searches nothing: a username prefix (within a domain when
// by_domain is given), a display name prefix, or a domain. Each is a range of lowercased text from the prefix to its
// successor (prefixEnd), compared in BINARY order as the index stores it.
function searchRange(filter: AdminAccountFilter): { index: string; where: string; values: SqlStorageValue[] } | null {
  if (filter.username !== null) {
    if (filter.byDomain !== null) {
      const range = prefixRange("lower(a.username)", filter.username, 2);
      return {
        index: "accounts_domain_username",
        where: `a.domain = ?1 AND ${range.where}`,
        values: [filter.byDomain, ...range.values],
      };
    }
    return { index: "accounts_username", ...prefixRange("lower(a.username)", filter.username, 1) };
  }
  if (filter.displayName !== null) {
    return { index: "accounts_display_name", ...prefixRange("lower(a.display_name)", filter.displayName, 1) };
  }
  if (filter.byDomain !== null) {
    return { index: "accounts_domain_username", where: "a.domain = ?1", values: [filter.byDomain] };
  }
  return null;
}

export type AdminAccountResult =
  | { status: "ok"; account: AdminAccount }
  | { status: "not_found" }
  // Mastodon's policy refusal for this account (403 "This action is not allowed").
  | { status: "not_allowed" };

// The actions on an account that change nothing in Kopje (Api::V1::Admin::AccountsController): enable, unsilence and
// unsensitive log the action and return the account, as Mastodon does for an account not in that state (Kopje has no
// disabled, silenced or sensitized account); enable needs a local account (require_local_account!). approve and reject
// are refused (403) for every account: require_local_account! refuses a remote one, and the policy (UserPolicy#approve?,
// #reject?) an approved user, which every local account is.
export type AdminAccountAction = "enable" | "unsilence" | "unsensitive" | "approve" | "reject";

type AdminDeclare = ReturnType<typeof adminGuarded>;

export function adminAccountOperations(read: AdminDeclare, write: AdminDeclare) {
  // GET /api/v1/admin/accounts and /api/v2/admin/accounts: newest first by id, paged by max_id, since_id and min_id
  // (Paginable#to_a_paginated_by_id). Each page is read through a plan whose range is in id order or from a set that is
  // operator-sized or capped (ADMIN_ACCOUNT_CANDIDATES), so a successful page is empty only at the true end, and
  // `more` says whether there is an older match (an ascending min_id page offers the next whenever it has accounts).
  const listAdminAccounts = read<{ filter: AdminAccountFilter; page: PageQuery; present: Present }, AdminAccountList>(
    ADMIN_PERMISSION.manageUsers,
    (db, { filter, page, present }, admin) => {
      if (matchesNothing(filter)) {
        return { status: "ok", items: [], newest: null, oldest: null, more: false };
      }
      const bounds = boundsOf(page);
      const found = readMatches(db, filter, admin.accountId, bounds, page.limit);
      if (found === "too_broad" || found === "moderating") {
        return { status: found };
      }
      // The page's accounts in its order, within ANSWER_BYTES (RES-3): cut there, the page ends at its last admitted
      // account, and `more` offers the next.
      const read = found.slice(0, page.limit).map((row) => row.id);
      const admitted = admit(adminAccountStream(db, read, admin.accountId, present), ARRAY_ANSWER_BYTES, true);
      const ids = read.slice(0, admitted.consumed);
      const more = bounds.ascending
        ? ids.length > 0
        : admitted.cut || found.length > page.limit || (bounds.min !== null && ids.length > 0);
      if (bounds.ascending) {
        ids.reverse();
        admitted.items.reverse();
      }
      return {
        status: "ok",
        items: admitted.items,
        newest: ids[0] ?? null,
        oldest: ids.at(-1) ?? null,
        more,
      };
    },
  );

  // GET /api/v1/admin/accounts/:id (Account.find: 404 for an id that is no account's).
  const getAdminAccount = read<{ id: string; present: Present }, AdminAccountResult>(
    ADMIN_PERMISSION.manageUsers,
    (db, { id, present }, admin) => {
      const account = presentAdminAccount(db, id, admin.accountId, present);
      return account === undefined ? { status: "not_found" } : { status: "ok", account };
    },
  );

  // POST /api/v1/admin/accounts/:id/{enable,unsilence,unsensitive,approve,reject}.
  const actOnAdminAccount = write<{ id: string; action: AdminAccountAction; present: Present }, AdminAccountResult>(
    ADMIN_PERMISSION.manageUsers,
    (db, { id, action, present }, admin) => {
      const account = presentAdminAccount(db, id, admin.accountId, present);
      if (account === undefined) {
        return { status: "not_found" };
      }
      if (action === "approve" || action === "reject" || (action === "enable" && account.domain !== null)) {
        return { status: "not_allowed" };
      }
      logAction(db, admin, action, { type: "Account", id }, {}, admin.now);
      return { status: "ok", account };
    },
  );

  // POST /api/v1/admin/accounts/:account_id/action (Admin::AccountAction#save!), in its order: the account (404), the
  // type (422), the text (422: Kopje's bound, WARNING_TEXT_BYTES), the policy (403: no action targets the OAuth
  // admin's own account, as Mastodon's role.overrides? refuses the Owner acting on the Owner), the warning preset (404:
  // Kopje has none, so any is unknown, as AccountWarningPreset.find raises), then the report named (404); each before
  // any write, as Mastodon's transaction rolls back.
  //   - none warns a local target when `notify` (send_email_notification) is set: a warning (account-warnings.ts,
  //     logged) and its moderation_warning notification, sent by the target itself, which R15 drops for a suspended
  //     target (DropCondition#drop?, unavailable) while the warning stays, as the strike does. Eligibility is judged in
  //     this transaction, where Mastodon judges it when LocalNotificationWorker runs. Then it resolves the report
  //     named, if any (process_reports!).
  //   - suspend on a local account suspends it (domain/suspension.ts): its reports, frozen at the suspension, are
  //     resolved by the suspension job, as process_reports! resolves every unresolved report on the target.
  //   - suspend on a remote account suspends it (remote-suspension.ts, R38): its reports, frozen at the suspension, are
  //     resolved by its job, which then ends its follows of local accounts.
  //   - disable, sensitive and silence answer 422 as a type outside the list would, so the client sees a failed action
  //     rather than a silent no-op: Kopje has no disabling, sensitizing or silencing.
  //   - suspend and a remote target keep no warning (account-warnings.ts).
  const actOnAccount = write<
    {
      id: string;
      type: string | null;
      reportId: string | null;
      warningPresetId: string | null;
      text: string;
      notify: boolean;
    },
    AccountActionResult
  >(ADMIN_PERMISSION.manageUsers, (db, { id, type, reportId, warningPresetId, text: sent, notify: warn }, admin) => {
    const account = db.first<{ id: string; domain: string | null }>("SELECT id, domain FROM accounts WHERE id = ?", id);
    if (account === undefined) {
      return { status: "not_found" };
    }
    if (type === null) {
      return { status: "invalid", error: "Validation failed: Type can't be blank, Type is not included in the list" };
    }
    if (type !== "none" && type !== "suspend") {
      return { status: "invalid", error: "Validation failed: Type is not included in the list" };
    }
    const text = storedWarningText(sent);
    if (text === null) {
      return {
        status: "invalid",
        error: `Validation failed: Text must be at most ${WARNING_TEXT_BYTES.toLocaleString("en-US")} UTF-8 bytes with no NUL`,
      };
    }
    if (account.id === admin.accountId) {
      return { status: "not_allowed" };
    }
    const statusIds = reportId === null ? null : reportStatusIds(db, reportId);
    if (warningPresetId !== null || statusIds === undefined) {
      return { status: "not_found" };
    }
    if (type === "none") {
      if (account.domain === null && warn) {
        const accountWarningId = writeAccountWarning(db, admin, account.id, text, statusIds);
        notify(db, {
          recipientId: account.id,
          type: "moderation_warning",
          fromId: account.id,
          statusId: null,
          accountWarningId,
          now: admin.now,
        });
      }
      if (reportId !== null) {
        resolveReport(db, reportId, admin);
      }
      return { status: "ok" };
    }
    if (account.domain === null) {
      suspendLocal(db, account.id, admin, admin.now);
    } else {
      suspendRemote(db, account.id, admin, admin.now);
    }
    return { status: "ok" };
  });

  // POST /api/v1/admin/accounts/:id/unsuspend (AccountPolicy#unsuspend?: a suspension of this instance's only): an
  // account that is not suspended, or a remote one unavailable for another reason (its deletion has started), is
  // refused (403). A remote account is not fetched again, as Mastodon's UnsuspendAccountService does. The OAuth admin
  // is never suspended (it is no admin then).
  const unsuspendAdminAccount = write<{ id: string; present: Present }, AdminAccountResult>(
    ADMIN_PERMISSION.manageUsers,
    (db, { id, present }, admin) => {
      const found = db.first<{ domain: string | null }>("SELECT domain FROM accounts WHERE id = ?", id);
      if (found === undefined) {
        return { status: "not_found" };
      }
      if (!(found.domain === null ? unsuspendLocal(db, id, admin.now) : unsuspendRemote(db, id) !== null)) {
        return { status: "not_allowed" };
      }
      logAction(db, admin, "unsuspend", { type: "Account", id }, {}, admin.now);
      return { status: "ok", account: presentAdminAccount(db, id, admin.accountId, present)! };
    },
  );

  return { listAdminAccounts, getAdminAccount, actOnAdminAccount, actOnAccount, unsuspendAdminAccount };
}

export type AccountActionResult =
  | { status: "ok" }
  | { status: "not_found" }
  | { status: "not_allowed" }
  // 422 with Mastodon's validation message.
  | { status: "invalid"; error: string };

export const { listAdminAccounts, getAdminAccount, actOnAdminAccount, actOnAccount, unsuspendAdminAccount } =
  adminAccountOperations(adminReadOperation, adminWriteOperation);
