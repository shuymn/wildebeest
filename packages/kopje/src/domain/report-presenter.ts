import type { Db } from "../db/sql";
import { type Account, type Present, presentAccountById } from "./accounts";

// The reporter's Report entity, for reports.ts and the notifications that carry one (notifications.ts). Reads only;
// reports.ts writes reports (R34).

// REST::ReportSerializer (app/serializers/rest/report_serializer.rb:3-20).
export type Report = {
  id: string;
  action_taken: boolean;
  action_taken_at: string | null;
  category: string;
  comment: string;
  forwarded: boolean;
  created_at: string;
  status_ids: string[];
  rule_ids: string[] | null;
  target_account: Account;
};

// The reporter's Report entity of report `id` (REST::ReportSerializer), a unit (its reported account and its fields):
// an admin.report notification shows its report so (REST::NotificationSerializer#report). Undefined for an id that
// names no report.
export function presentReport(db: Db, id: string, present: Present): Report | undefined {
  const row = db.first<ReportRow>(`SELECT ${REPORT_COLUMNS} FROM reports WHERE id = CAST(? AS INTEGER)`, id);
  const target = row === undefined ? undefined : presentAccountById(db, row.target_account_id, present);
  return row === undefined || target === undefined ? undefined : userReport(row, target);
}

export type ReportRow = {
  id: string;
  account_id: string;
  target_account_id: string;
  status_ids: string;
  comment: string;
  category: string;
  rule_ids: string | null;
  forwarded: number;
  created_at: string;
  action_taken_at: string | null;
  action_taken_by_account_id: string | null;
  assigned_account_id: string | null;
  updated_at: string | null;
  // The reporter's domain: null for a local reporter.
  reporter_domain: string | null;
};

export const REPORT_COLUMNS = `CAST(id AS TEXT) AS id, account_id, target_account_id, status_ids, comment, category, rule_ids,
	forwarded, created_at, action_taken_at, action_taken_by_account_id, assigned_account_id, updated_at,
	(SELECT domain FROM accounts WHERE accounts.id = reports.account_id) AS reporter_domain`;

// The reporter's Report entity (REST::ReportSerializer): action_taken once the OAuth admin resolved it.
export function userReport(row: ReportRow, targetAccount: Account): Report {
  return {
    id: row.id,
    action_taken: row.action_taken_at !== null,
    action_taken_at: row.action_taken_at,
    category: row.category,
    comment: row.comment,
    forwarded: row.forwarded === 1,
    created_at: row.created_at,
    status_ids: JSON.parse(row.status_ids) as string[],
    rule_ids: row.rule_ids === null ? null : (JSON.parse(row.rule_ids) as string[]),
    target_account: targetAccount,
  };
}
