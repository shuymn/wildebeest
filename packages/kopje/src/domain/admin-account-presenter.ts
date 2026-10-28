import type { Db } from "../db/sql";
import { type Account, accountsOf, type Present } from "./accounts";
import { EVERYONE_ROLE, OWNER_ROLE, type Role } from "./auth";

// The Admin::Account entity, for admin-accounts.ts and the reports it is nested in (reports.ts).

// REST::Admin::AccountSerializer (app/serializers/rest/admin/account_serializer.rb:3-87), in its order. Kopje has no
// sign-ups, approvals, disabling, silencing, sensitizing, invites or recorded IPs:
//   - a local account (a User in Mastodon): its email; confirmed and approved; not disabled, silenced or sensitized;
//     locale null (Kopje stores none); its role (Owner for the OAuth admin, the default role for every other);
//   - a remote account (no User): email, confirmed, disabled, approved, locale and role null, which is what
//     Account's delegation to a missing user gives (app/models/account.rb:173-191, allow_nil);
//   - both: ip null and ips [], invite_request null; created_by_application_id and invited_by_account_id absent (their
//     conditions never hold); suspended when the account is unavailable (R1), as the nested account shows it.
export type AdminAccount = {
  id: string;
  username: string;
  domain: string | null;
  created_at: string;
  email: string | null;
  ip: null;
  confirmed: boolean | null;
  suspended: boolean;
  silenced: boolean;
  sensitized: boolean;
  disabled: boolean | null;
  approved: boolean | null;
  locale: null;
  invite_request: null;
  ips: never[];
  account: Account;
  role: Role | null;
};

// The admin entities of `ids` in order (an id may repeat), for an admission (admit): read `chunk` at a time as the
// stream reaches them, each account through accountsOf (RES-2); undefined for an id with no account. `adminId` is the
// OAuth admin the calling admin operation has just checked (adminGuarded), whose account shows the admin role.
export function* adminAccountStream(
  db: Db,
  ids: readonly string[],
  adminId: string,
  present: Present,
  chunk = ADMIN_ACCOUNT_CHUNK,
): Generator<AdminAccount | undefined, undefined> {
  for (let next = 0; next < ids.length; next += chunk) {
    const slice = ids.slice(next, next + chunk);
    const rows = new Map(
      db
        .all<{ id: string; domain: string | null; email: string | null }>(
          `SELECT a.id, a.domain, l.email FROM json_each(?1) c CROSS JOIN accounts a ON a.id = c.value
						LEFT JOIN local_accounts l ON l.account_id = a.id`,
          JSON.stringify([...new Set(slice)]),
        )
        .map((row) => [row.id, row]),
    );
    const accounts = accountsOf(db, slice, present, chunk);
    for (const id of slice) {
      const account = accounts.next().value;
      const row = rows.get(id);
      if (account === undefined || row === undefined) {
        yield undefined;
        continue;
      }
      const local = row.domain === null;
      yield {
        id: row.id,
        username: account.username,
        domain: row.domain,
        created_at: account.created_at,
        email: local ? row.email : null,
        ip: null,
        confirmed: local ? true : null,
        suspended: account.suspended === true,
        silenced: false,
        sensitized: false,
        disabled: local ? false : null,
        approved: local ? true : null,
        locale: null,
        invite_request: null,
        ips: [],
        account,
        role: local ? (row.id === adminId ? OWNER_ROLE : EVERYONE_ROLE) : null,
      };
    }
  }
}

// Admin entities read per query while an answer is admitted: one chunk at their bound is about 2.5 MB (RES-2).
const ADMIN_ACCOUNT_CHUNK = 20;
