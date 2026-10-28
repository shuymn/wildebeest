import { ACCOUNTS_URI_INDEX, STATUSES_URI_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { blockedDomain } from "../platform/domain-name";
import { ACTIVITY_ID_LIMIT, withinIdentityBound } from "../platform/identity-bounds";
import type { ImportAuthority } from "../platform/store-admin";
import { accountUrl, type Page, type PageQuery, type Present, presentAccountById, resolveAccountId } from "./accounts";
import { flagActivity, instanceActorUri, recordOutbound } from "./activities";
import { type AdminAccount, adminAccountStream } from "./admin-account-presenter";
import { accessAdminRefusal, adminAccountIdOnce } from "./admin-authority";
import { admit, ARRAY_ANSWER_BYTES, jsonBytes } from "./answer-budget";
import { availableSql, type ReachedAccount, reachAccount, remoteReportStatusIds, reportForwardees } from "./audience";
import {
  ADMIN_PERMISSION,
  type Admin,
  adminReadOperation,
  adminWriteOperation,
  userWriteOperation,
  viewerOf,
} from "./auth";
import { type InstanceRule, parseRules } from "./instance";
import { reportsRejected } from "./instance-domain-blocks";
import { logAction } from "./moderation-log";
import { notify } from "./notifications";
import { readOperation } from "./operation";
import { actorUriSql, usernameSql } from "./profile-bounds";
import { type Report, type ReportRow, REPORT_COLUMNS, userReport } from "./report-presenter";
import { LARGE_ITEM_CHUNKS, presentation, type Status, statusStream } from "./status-presenter";
import { accountStatusIds } from "./timelines";
import { edgeRangeSql } from "./windows";

// Reports (Mastodon 4.5's POST /api/v1/reports: Api::V1::ReportsController, ReportService, Report; migrations
// 0022_reports and 0054_remote_reports). A local account reports an account, optionally naming statuses of it and
// instance rules, and may ask that the report be forwarded to the servers concerned; a remote server reports through
// an inbound Flag (fileRemoteReports, below). The report is its reporter's (R34): it is stored for the instance's
// moderation, answered once to a local reporter, and read otherwise only by the OAuth admin through the Mastodon admin
// API (R37, below).
//
//   - The reported account must be available (ReportService#call raises RecordNotFound when it is unavailable,
//     app/services/report_service.rb:16): anything else is not found.
//   - Each reported status must be one of the account's that the reporter may see by AccountStatusesFilter (R11,
//     report_service.rb:82, `.find` of all of them): one that is not, or that is not the account's, makes the whole
//     report not found. Kopje keeps no deleted status, so with_discarded finds no more than the rule does.
//   - rule_ids make the category `violation` (report_service.rb:11); a blank category is `other`. Report's validations
//     (app/models/report.rb:53-56, 168-170) then hold: a comment of at most 1,000 characters, and a violation names
//     rules that all exist, each once; their messages are Rails'.
//   - Forwarding (report_service.rb:21-24, 53-79): only for a remote account and `forward` true. The Flag goes to the
//     account's server when its domain is in forward_to_domains (by default the account's own; `forwarded` records
//     it), and to the servers of the accounts the reported statuses reply to on the listed domains, less the reported
//     account's inboxes (reportForwardees, R23). It is signed by the instance actor (report_service.rb:98-100), so the
//     reporter is not named, and delivered by the outbound path as any other activity without to (deliveries.ts): by
//     each server's shared inbox when the account has one, where Mastodon posts to the reported account's own inbox.
//   - The OAuth admin is notified (notify_staff!, report_service.rb:44-51) by notifyStaff below.
//
// Bounds (RES-7): Mastodon sets none on status_ids or forward_to_domains; Kopje takes at most MAX_REPORT_STATUSES and
// MAX_FORWARD_DOMAINS (more answer 422 before any status is read). The statuses are read by key, and the replied-to
// accounts through them.

export const MAX_REPORT_STATUSES = 100;
export const MAX_FORWARD_DOMAINS = 100;
// Report::COMMENT_SIZE_LIMIT (app/models/report.rb:30).
export const MAX_REPORT_COMMENT = 1_000;

// Report's category enum (app/models/report.rb:62-67).
const CATEGORIES = new Set(["other", "spam", "legal", "violation"]);

export type ReportInput = {
  account: string;
  statusIds: string[];
  comment: string | undefined;
  category: string | undefined;
  ruleIds: string[];
  forward: boolean;
  // The domains sent as forward_to_domains, or null when the parameter was not sent.
  forwardToDomains: string[] | null;
  present: Present;
  now: number;
};

export type ReportResult =
  | { status: "ok"; report: Report }
  | { status: "not_found" }
  | { status: "invalid"; errors: string[] };

// Ruby's String#blank?, which `presence` reads.
const blank = (value: string | undefined): boolean => value === undefined || /^\s*$/u.test(value);

export const createReport = userWriteOperation<ReportInput, ReportResult>((db, input, _viewer, viewer) => {
  const target = resolveAccountId(db, input.account);
  if (target === null) {
    return { status: "not_found" };
  }
  const account = db.first<{ domain: string | null; uri: string }>(
    `SELECT domain, uri FROM accounts WHERE id = ?1 AND ${availableSql("?1")}`,
    target,
  );
  if (account === undefined) {
    return { status: "not_found" };
  }
  // A JSON empty array reads as one blank value (params.ts); Mastodon's JSON body sends none.
  const statusIds = [...new Set(input.statusIds.filter((id) => id !== ""))];
  const ruleIds = input.ruleIds.filter((id) => id !== "");
  const bounds = [
    ...(statusIds.length > MAX_REPORT_STATUSES
      ? [`Status ids is too long (maximum is ${MAX_REPORT_STATUSES} statuses)`]
      : []),
    ...((input.forwardToDomains?.length ?? 0) > MAX_FORWARD_DOMAINS
      ? [`Forward to domains is too long (maximum is ${MAX_FORWARD_DOMAINS} domains)`]
      : []),
  ];
  if (bounds.length > 0) {
    return { status: "invalid", errors: bounds };
  }
  const statuses = accountStatusIds(db, viewer, target, statusIds);
  if (statuses.length !== statusIds.length) {
    return { status: "not_found" };
  }
  const category = ruleIds.length > 0 ? "violation" : blank(input.category) ? "other" : (input.category as string);
  const comment = blank(input.comment) ? "" : (input.comment as string);
  const errors = validate(db, { category, comment, ruleIds });
  if (errors.length > 0) {
    return { status: "invalid", errors };
  }

  const forward = input.forward && account.domain !== null;
  const domains = [
    ...new Set((input.forwardToDomains ?? [account.domain ?? ""]).flatMap((domain) => blockedDomain(domain) ?? [])),
  ];
  const forwarded = forward && account.domain !== null && domains.includes(account.domain);
  const domain = instanceDomain(db, input.present);
  const uri = `${instanceActorUri(domain)}#reports/${crypto.randomUUID()}`;
  const row = db.first<ReportRow>(
    `INSERT INTO reports (account_id, target_account_id, status_ids, comment, category, rule_ids, forwarded, uri,
			created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${REPORT_COLUMNS}`,
    viewer.accountId,
    target,
    JSON.stringify(statusIds),
    comment,
    category,
    ruleIds.length === 0 ? null : JSON.stringify(ruleIds),
    forwarded ? 1 : 0,
    uri,
    new Date(input.now).toISOString(),
  )!;
  notifyStaff(db, row, input.now);
  if (forward) {
    const recipients = reportForwardees(db, target, statusIds, domains);
    if (recipients.length > 0) {
      recordOutbound(
        db,
        viewer.accountId,
        flagActivity({
          id: uri,
          actorUri: instanceActorUri(domain),
          targetUri: account.uri,
          statusUris: statuses.map((status) => status.uri),
          comment,
          recipients,
        }),
        input.now,
      );
    }
  }
  return { status: "ok", report: userReport(row, presentAccountById(db, target, input.present)!) };
});

// ---- Remote reports: an inbound Flag (Mastodon's ActivityPub::Activity::Flag, app/lib/activitypub/activity/flag.rb;
// migration 0054_remote_reports). Misskey sends one when a moderator forwards a report (from its system actor, an
// Application, with the account's uri as the object and the comment as plain text, AbuseReportService.ts:121-143);
// Mastodon when a user forwards one (from its instance actor, naming the account and the statuses).

// The object entries a Flag is read for at most: one account and MAX_REPORT_STATUSES statuses (RES-7). Mastodon reads
// them all.
export const MAX_FLAG_OBJECTS = MAX_REPORT_STATUSES + 1;
// ActivityPub::Activity::Flag::COMMENT_SIZE_LIMIT (flag.rb:4), in code points.
export const MAX_REMOTE_REPORT_COMMENT = 5_000;
// The unresolved reports one remote actor may have at most (RES-7): a Flag that would pass it files none. Per actor,
// not per server (Mastodon and Misskey send Flags from one instance or system actor). Mastodon sets no bound.
export const MAX_UNRESOLVED_REMOTE_REPORTS = 100;

// A Flag's comment as stored: a string's first MAX_REMOTE_REPORT_COMMENT code points (a lone surrogate read as
// U+FFFD, a NUL kept), '' for anything else or a blank one (Mastodon's `content[0...5000]` and `presence || ''`). It is
// plain text, never rendered as HTML. At most 20,000 UTF-8 bytes, which the CHECK of 0054_remote_reports holds.
export function reportComment(content: unknown): string {
  if (typeof content !== "string") {
    return "";
  }
  const cut = [...content.toWellFormed()].slice(0, MAX_REMOTE_REPORT_COMMENT).join("");
  return blank(cut) ? "" : cut;
}

// The Flag's object ids Kopje reads: the first MAX_FLAG_OBJECTS entries, each once, each within ACTIVITY_ID_LIMIT
// (a longer one is skipped: no stored account or status has it).
export function flagObjects(listed: readonly string[]): string[] {
  return [...new Set(listed.slice(0, MAX_FLAG_OBJECTS))].filter((uri) => withinIdentityBound(uri, ACTIVITY_ID_LIMIT));
}

export type RemoteFlag = { id: string; objects: readonly string[]; content: string };

export type FiledReports = { filed: boolean; reason: string };

// R34, ID-5, ID-6, ID-7: file reports from a verified remote Flag in the receive transaction.
// Recheck Worker-parsed bounds for direct RPC callers. reject_reports or the unresolved-report cap
// refuses the whole Flag without writes. Target/status admission: docs/visibility.md R34;
// bounds: docs/threat-model.md RES-2 and RES-7. notifyStaff records each new report's notification.
export function fileRemoteReports(
  db: Db,
  actor: { id: string; domain: string },
  flag: RemoteFlag,
  now: number,
): FiledReports {
  if (!withinIdentityBound(flag.id, ACTIVITY_ID_LIMIT)) {
    return { filed: false, reason: "id-past-bound" };
  }
  if (reportsRejected(db, actor.domain)) {
    return { filed: false, reason: "reports-rejected" };
  }
  const objects = JSON.stringify(flagObjects(flag.objects));
  // Each object sought by uri among the accounts and the statuses (RES-7).
  const accounts = db.all<{ id: string; local: number; available: number }>(
    `SELECT a.id, a.domain IS NULL AS local, ${availableSql("a.id")} AS available
		FROM json_each(?1) j CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_URI_INDEX} ON a.uri = j.value ORDER BY j.key`,
    objects,
  );
  const statuses = db.all<{ id: string; account_id: string; replies_to_local: number }>(
    `SELECT s.id, s.account_id,
			EXISTS (SELECT 1 FROM local_accounts l WHERE l.account_id = s.in_reply_to_account_id) AS replies_to_local
		FROM json_each(?1) j CROSS JOIN statuses s INDEXED BY ${STATUSES_URI_INDEX} ON s.uri = j.value
		WHERE s.reblog_of_id IS NULL ORDER BY j.key`,
    objects,
  );
  const repliesToLocal = (target: string) =>
    statuses.some((status) => status.account_id === target && status.replies_to_local === 1);
  const distinct = [
    ...new Set(
      accounts
        .filter((account) => account.available === 1 && (account.local === 1 || repliesToLocal(account.id)))
        .map((account) => account.id),
    ),
  ];
  if (distinct.length === 0) {
    return { filed: false, reason: "no-target" };
  }
  const filed = new Set(
    db
      .all<{ target: string }>(
        `SELECT target_account_id AS target FROM reports
				WHERE uri = ?1 AND target_account_id IN (SELECT value FROM json_each(?2))`,
        flag.id,
        JSON.stringify(distinct),
      )
      .map((row) => row.target),
  );
  const fresh = distinct.filter((target) => !filed.has(target));
  if (fresh.length === 0) {
    return { filed: false, reason: "duplicate" };
  }
  const unresolved =
    db.first<{ n: number }>(
      `SELECT count(*) AS n FROM (SELECT 1 FROM reports INDEXED BY reports_account_state
				WHERE account_id = ?1 AND (action_taken_at IS NULL) = 1 LIMIT ?2)`,
      actor.id,
      MAX_UNRESOLVED_REMOTE_REPORTS + 1,
    )?.n ?? 0;
  if (unresolved + fresh.length > MAX_UNRESOLVED_REMOTE_REPORTS) {
    return { filed: false, reason: "report-limit" };
  }
  const comment = reportComment(flag.content);
  for (const target of fresh) {
    const named = statuses.filter((status) => status.account_id === target).map((status) => status.id);
    const statusIds = remoteReportStatusIds(db, actor.domain, target, named.slice(0, MAX_REPORT_STATUSES));
    const row = db.first<ReportRow>(
      `INSERT INTO reports (account_id, target_account_id, status_ids, comment, category, rule_ids, forwarded, uri,
				created_at)
			VALUES (?, ?, ?, ?, 'other', NULL, 0, ?, ?) ON CONFLICT (uri, target_account_id) DO NOTHING
			RETURNING ${REPORT_COLUMNS}`,
      actor.id,
      target,
      JSON.stringify(statusIds.map((status) => status.id)),
      comment,
      flag.id,
      new Date(now).toISOString(),
    );
    if (row !== undefined) {
      notifyStaff(db, row, now);
    }
  }
  return { filed: true, reason: "reported" };
}

// ReportService#notify_staff! (report_service.rb:44-51) for a report just written, in its transaction: the OAuth admin
// (R37) is notified (admin.report) unless another report of the same account is unresolved
// (Report#unresolved_siblings?, app/models/report.rb:128-130), so only the first unresolved report of an account
// notifies. One seek in reports_target_state finds a sibling, however many reports the account has. Mastodon notifies
// every user who can manage reports; Kopje's one is the OAuth admin, none when there is none. The rule then refuses the
// admin's own report (NotifyService's from_self?), a reporter the admin blocks, mutes with notifications or
// domain-blocks, and an unavailable reporter (shownSql). A remote report's notification is from its remote reporter.
function notifyStaff(db: Db, report: ReportRow, now: number): void {
  const sibling = db.first(
    `SELECT 1 AS x FROM reports INDEXED BY reports_target_state
		WHERE target_account_id = ?1 AND (action_taken_at IS NULL) = 1 AND id <> CAST(?2 AS INTEGER) LIMIT 1`,
    report.target_account_id,
    report.id,
  );
  const admin = sibling === undefined ? adminAccountIdOnce(db) : null;
  if (admin === null) {
    return;
  }
  notify(db, {
    recipientId: admin,
    type: "admin.report",
    fromId: report.account_id,
    statusId: null,
    reportId: report.id,
    now,
  });
}

// Report's validations, in Rails' order and words: the comment's length, then the rules of a violation (which must
// name rules that all exist, each once: `rules.size == rule_ids&.size`). The category is one of the enum's; Mastodon
// raises on any other (an ArgumentError, answered 500), Kopje refuses it as a validation would.
function validate(db: Db, report: { category: string; comment: string; ruleIds: string[] }): string[] {
  const errors: string[] = [];
  if (!CATEGORIES.has(report.category)) {
    errors.push("Category is not included in the list");
  }
  if ([...report.comment].length > MAX_REPORT_COMMENT) {
    errors.push(`Comment is too long (maximum is ${MAX_REPORT_COMMENT} characters)`);
  }
  if (report.category === "violation") {
    const rules = new Set(
      parseRules(db.first<{ value: string }>("SELECT value FROM instance_settings WHERE name = 'rules'")?.value).map(
        (rule) => rule.id,
      ),
    );
    const named = new Set(report.ruleIds);
    if (
      report.ruleIds.length === 0 ||
      named.size !== report.ruleIds.length ||
      report.ruleIds.some((id) => !rules.has(id))
    ) {
      errors.push("Rule ids does not reference valid rules");
    }
  }
  return errors;
}

// The domain fixed at /setup, which names the instance actor.
function instanceDomain(db: Db, present: Present): string {
  return (
    db.first<{ value: string }>("SELECT value FROM instance_settings WHERE name = 'domain'")?.value ??
    new URL(present.origin).host
  );
}

// ---- The Mastodon admin API's reports (Api::V1::Admin::ReportsController, app/controllers/api/v1/admin/
// reports_controller.rb; R37, VIS-29): every report, to the OAuth admin only (adminReadOperation, adminWriteOperation:
// anyone else is refused before a report is read, so a report's existence is not disclosed either).

// REST::Admin::ReportSerializer (app/serializers/rest/admin/report_serializer.rb:3-21), in its order.
export type AdminReport = {
  id: string;
  action_taken: boolean;
  action_taken_at: string | null;
  category: string;
  comment: string;
  forwarded: boolean;
  created_at: string;
  updated_at: string;
  account: AdminAccount;
  target_account: AdminAccount;
  assigned_account: AdminAccount | null;
  action_taken_by_account: AdminAccount | null;
  statuses: Status[];
  rules: InstanceRule[];
};

// The index's page (reports_controller.rb:7, Api::BaseController#limit_param: 100 by default, at most twice that).
export const ADMIN_REPORTS_LIMIT = 100;
export const MAX_ADMIN_REPORTS_LIMIT = 200;
// The statuses one page of the index presents at most: a page stops before a report that would pass this, after at
// least one, and offers the next page. One report's worth (MAX_REPORT_STATUSES), which bounds the statuses a page
// reads and presents; its bytes are bounded by ANSWER_BYTES (listAdminReports).
export const ADMIN_REPORT_STATUS_BUDGET = MAX_REPORT_STATUSES;

// The rules of the instance, read once per response.
function instanceRules(db: Db): InstanceRule[] {
  return parseRules(db.first<{ value: string }>("SELECT value FROM instance_settings WHERE name = 'rules'")?.value);
}

// The bytes of the statuses one report embeds at most past its first (RES-3): its statuses are admitted in the order
// it shows them while their JSON fits, the first whatever its size (a unit), so a report is at most its accounts and
// fields, its first status and this allowance ("Maxima of presented units" in docs/threat-model.md). A report whose
// statuses pass it is shown with fewer statuses than it holds: a projection of the report, which keeps them all.
export const REPORT_STATUS_BYTES = 2 * 1024 * 1024;

// The admin entities of `rows`, in their order, for an admission (admit): each report atomic, presented when the
// admission reaches it, with its four accounts read for it alone and its statuses within REPORT_STATUS_BYTES. A
// report's statuses are shown only while its reporter may still see them by the rule the report was made under (R37):
// for a local reporter the account statuses rule (R11, accountStatusIds, with the reporter as the viewer at the
// admin's request time), for a remote one the remote reporter rule (remoteReportStatusIds); they are presented with
// the admin as the viewer. Mastodon shows them regardless, discarded ones included (Report#statuses,
// app/models/report.rb:78-80). The report's own status_ids (the ids admitted when it was filed) are its metadata,
// shown as stored in the admin's admin.report notifications (userReport). The page's statuses share one
// presentation, so a keyword deep in a long status of a large page may be missed where the report read alone matches
// it, as on timelines (filters.ts).
// The rules are the instance's that the report names, in the instance's order; Mastodon keeps discarded rules
// (Rule.with_discarded), which Kopje does not store.
function* adminReportStream(
  db: Db,
  rows: readonly ReportRow[],
  admin: Admin,
  present: Present,
): Generator<AdminReport, undefined> {
  const rules = rows.some((row) => row.rule_ids !== null) ? instanceRules(db) : [];
  const shown = rows.map((row) => {
    const ids = JSON.parse(row.status_ids) as string[];
    return row.reporter_domain === null
      ? accountStatusIds(db, viewerOf(admin, row.account_id), row.target_account_id, ids)
      : remoteReportStatusIds(db, row.reporter_domain, row.target_account_id, ids);
  });
  // One presentation for the answer: its keywords are matched against at most MAX_FILTER_REQUEST_TEXT in all.
  const shared = presentation(
    db,
    shown.flatMap((statuses) => statuses.map((status) => status.id)),
    { ...present, viewer: admin.context },
  );
  for (const [i, row] of rows.entries()) {
    const ids = [
      row.account_id,
      row.target_account_id,
      row.assigned_account_id ?? "",
      row.action_taken_by_account_id ?? "",
    ];
    const [account, target, assigned, actor] = [...adminAccountStream(db, ids, admin.accountId, present, ids.length)];
    const ruleIds = new Set(row.rule_ids === null ? [] : (JSON.parse(row.rule_ids) as string[]));
    const statuses = (shown[i] ?? []).map((status) => status.id);
    // Statuses are read in chunks of LARGE_ITEM_CHUNKS ("Heap at 8 MiB per answer" in docs/threat-model.md). The
    // first presented, whatever its size (a unit); the next ones only while room is left in REPORT_STATUS_BYTES, so a
    // first status that uses up the allowance stops the report's statuses past the rows of its chunk.
    const stream = statusStream(db, shared, statuses, LARGE_ITEM_CHUNKS);
    let first: Status | undefined;
    let next = 0;
    while (first === undefined && next < statuses.length) {
      first = stream.next().value;
      next++;
    }
    const used = first === undefined ? 0 : jsonBytes(first) + 1;
    const embedded =
      first === undefined
        ? []
        : [first, ...(used >= REPORT_STATUS_BYTES ? [] : admit(stream, REPORT_STATUS_BYTES - used, false).items)];
    yield {
      id: row.id,
      action_taken: row.action_taken_at !== null,
      action_taken_at: row.action_taken_at,
      category: row.category,
      comment: row.comment,
      forwarded: row.forwarded === 1,
      created_at: row.created_at,
      updated_at: row.updated_at ?? row.created_at,
      account: account!,
      target_account: target!,
      assigned_account: assigned ?? null,
      action_taken_by_account: actor ?? null,
      statuses: embedded,
      rules: rules.filter((rule) => ruleIds.has(rule.id)),
    };
  }
}

// ReportFilter (app/models/report_filter.rb:18-25) over the parameters the controller permits (reports_controller.rb:
// 17-21, 88-90): unresolved reports by default, and resolved ones when `resolved` is sent with any value, even
// "false" (scope_for adds Report.resolved for the key, whatever its value); account_id (the reporter) and
// target_account_id. by_target_domain and target_origin are not permitted, so they are ignored.
export type AdminReportFilter = { resolved: boolean; accountId: string | null; targetAccountId: string | null };

export type AdminReportPage = Page<AdminReport> & { more: boolean };

// GET /api/v1/admin/reports: newest first by id, paged by max_id, since_id and min_id (Paginable#to_a_paginated_by_id).
// Each filter reads one index whose range is already in id order for the state: reports_state alone,
// reports_account_state for a reporter, reports_target_state for a reported account, and reports_pair_state when both
// are given (RES-7: no residual, however many others report the account). A
// page holds `limit` reports, or fewer when the status budget or ANSWER_BYTES stops it after at least one report;
// `more` offers the next page then too, so a short page with `more` false is the end (Mastodon offers it when the
// page is full).
export const listAdminReports = adminReadOperation<
  { filter: AdminReportFilter; page: PageQuery; present: Present },
  AdminReportPage
>(ADMIN_PERMISSION.manageReports, (db, { filter, page, present }, admin) => {
  const ascending = page.minId !== undefined;
  // The index, and the equality on its leading columns: ?4 on, after the cursor's. The range and the order name
  // reports.id, not the text id the columns answer.
  const [index, keys, ...values] =
    filter.targetAccountId !== null
      ? filter.accountId !== null
        ? ([
            "reports_pair_state",
            "target_account_id = ?4 AND account_id = ?5",
            filter.targetAccountId,
            filter.accountId,
          ] as const)
        : (["reports_target_state", "target_account_id = ?4", filter.targetAccountId] as const)
      : filter.accountId !== null
        ? (["reports_account_state", "account_id = ?4", filter.accountId] as const)
        : (["reports_state", "1"] as const);
  const rows = db.all<ReportRow>(
    `SELECT ${REPORT_COLUMNS} FROM reports INDEXED BY ${index}
		WHERE ${keys} AND (action_taken_at IS NULL) = ${filter.resolved ? 0 : 1} AND ${edgeRangeSql("reports.id", "?1", "?2")}
		ORDER BY reports.id ${ascending ? "ASC" : "DESC"} LIMIT ?3`,
    page.maxId ?? null,
    page.minId ?? page.sinceId ?? null,
    page.limit,
    ...values,
  );
  // The reports up to the status budget, in the order read: always the first.
  const kept: ReportRow[] = [];
  let statuses = 0;
  for (const row of rows) {
    const count = (JSON.parse(row.status_ids) as string[]).length;
    if (kept.length > 0 && statuses + count > ADMIN_REPORT_STATUS_BUDGET) {
      break;
    }
    kept.push(row);
    statuses += count;
  }
  // Within ANSWER_BYTES (RES-3), cut at a report: the page ends at its last admitted report, and `more` offers the
  // next.
  const admitted = admit(adminReportStream(db, kept, admin, present), ARRAY_ANSWER_BYTES, true);
  const shown = kept.slice(0, admitted.consumed);
  if (ascending) {
    shown.reverse();
    admitted.items.reverse();
  }
  return {
    items: admitted.items,
    newest: shown[0]?.id ?? null,
    oldest: shown.at(-1)?.id ?? null,
    more: rows.length === page.limit || shown.length < rows.length,
  };
});

export type AdminReportResult =
  | { status: "ok"; report: AdminReport }
  | { status: "not_found" }
  | { status: "invalid"; errors: string[] };

// A report by its API id (Report.find, which reads digits as the integer they spell): anything else is not found.
function reportRow(db: Db, id: string): ReportRow | undefined {
  return /^\d{1,18}$/.test(id)
    ? db.first<ReportRow>(`SELECT ${REPORT_COLUMNS} FROM reports WHERE reports.id = CAST(? AS INTEGER)`, id)
    : undefined;
}

// One report, a unit (its statuses within REPORT_STATUS_BYTES).
function presented(db: Db, row: ReportRow, admin: Admin, present: Present): AdminReportResult {
  return { status: "ok", report: adminReportStream(db, [row], admin, present).next().value! };
}

// GET /api/v1/admin/reports/:id.
export const getAdminReport = adminReadOperation<{ id: string; present: Present }, AdminReportResult>(
  ADMIN_PERMISSION.manageReports,
  (db, { id, present }, admin) => {
    const row = reportRow(db, id);
    return row === undefined ? { status: "not_found" } : presented(db, row, admin, present);
  },
);

// The moderation actions on a report (reports_controller.rb:42-68, Report#resolve! and #unresolve!,
// app/models/report.rb:102-116), each logged as Mastodon logs it (log_action) in the same transaction. The columns
// change only when their values do, and updated_at with them, as Rails saves only a changed record; the log is written
// either way, as Mastodon writes it.
export type ReportAction = "assign_to_self" | "unassign" | "resolve" | "reopen";

const ACTIONS: Record<ReportAction, { log: string; set: (admin: Admin, now: string) => Partial<ReportRow> }> = {
  assign_to_self: { log: "assigned_to_self", set: (admin) => ({ assigned_account_id: admin.accountId }) },
  unassign: { log: "unassigned", set: () => ({ assigned_account_id: null }) },
  resolve: {
    log: "resolve",
    set: (admin, now) => ({ action_taken_at: now, action_taken_by_account_id: admin.accountId }),
  },
  reopen: { log: "reopen", set: () => ({ action_taken_at: null, action_taken_by_account_id: null }) },
};

// An admin write to `row`, logged as `action` with `detail` (moderation-log.ts). The changed columns are saved with
// updated_at, as Rails saves only a changed record (ReportAction); last_action_id takes the log row either way
// (VIS-29), in the same UPDATE.
function writeReport(
  db: Db,
  admin: Admin,
  row: ReportRow,
  changes: Partial<ReportRow>,
  now: string,
  action: string,
  detail: Record<string, unknown> = {},
): ReportRow {
  const logged = logAction(db, admin, action, { type: "Report", id: row.id }, detail, admin.now);
  const changed = Object.entries(changes).filter(([column, value]) => row[column as keyof ReportRow] !== value);
  const saved = changed.length > 0 ? [...changed, ["updated_at", now]] : [];
  db.run(
    `UPDATE reports SET ${[...saved.map(([column]) => `${column} = ?`), "last_action_id = ?"].join(", ")} WHERE id = ?`,
    ...saved.map(([, value]) => value as string | null),
    logged,
    row.id,
  );
  return { ...row, ...Object.fromEntries(saved) } as ReportRow;
}

// POST /api/v1/admin/reports/:id/assign_to_self, unassign, resolve and reopen.
export const actOnReport = adminWriteOperation<
  { id: string; action: ReportAction; present: Present },
  AdminReportResult
>(ADMIN_PERMISSION.manageReports, (db, { id, action, present }, admin) => {
  const row = reportRow(db, id);
  if (row === undefined) {
    return { status: "not_found" };
  }
  const now = new Date(admin.now).toISOString();
  const updated = writeReport(db, admin, row, ACTIONS[action].set(admin, now), now, ACTIONS[action].log);
  return presented(db, updated, admin, present);
});

// PUT and PATCH /api/v1/admin/reports/:id: category and rule_ids (report_params, reports_controller.rb:84-86), each
// changed only when sent. Report's validations run when either changes (app/models/report.rb:53-56, 168-170), in
// Rails' order and words: a category that is not a violation names no rules (`absence`, so an empty list passes),
// and a violation names rules that all exist, each once (`rules.size == rule_ids&.size`, so an empty list passes and
// none does not). A category outside the enum, or blank, answers 422 as a validation would, where Mastodon raises
// (ArgumentError, or the NOT NULL constraint) and answers 500. The update is logged either way.
export const updateAdminReport = adminWriteOperation<
  { id: string; category: string | undefined; ruleIds: string[] | undefined; present: Present },
  AdminReportResult
>(ADMIN_PERMISSION.manageReports, (db, { id, category, ruleIds, present }, admin) => {
  const row = reportRow(db, id);
  if (row === undefined) {
    return { status: "not_found" };
  }
  const stored = row.rule_ids === null ? null : (JSON.parse(row.rule_ids) as string[]);
  const nextCategory = category ?? row.category;
  const nextRules = ruleIds ?? stored;
  if (!CATEGORIES.has(nextCategory)) {
    return { status: "invalid", errors: ["Category is not included in the list"] };
  }
  const changed = nextCategory !== row.category || JSON.stringify(nextRules) !== JSON.stringify(stored);
  const errors: string[] = [];
  if (changed && nextCategory !== "violation" && (nextRules?.length ?? 0) > 0) {
    errors.push("Rule ids must be blank");
  }
  if (changed && nextCategory === "violation") {
    const rules = new Set(instanceRules(db).map((rule) => rule.id));
    if (nextRules === null || new Set(nextRules).size !== nextRules.length || nextRules.some((id) => !rules.has(id))) {
      errors.push("Rule ids does not reference valid rules");
    }
  }
  if (errors.length > 0) {
    return { status: "invalid", errors };
  }
  const now = new Date(admin.now).toISOString();
  const updated = writeReport(
    db,
    admin,
    row,
    { category: nextCategory, rule_ids: nextRules === null ? null : JSON.stringify(nextRules) },
    now,
    "update",
    { category: nextCategory, rule_ids: nextRules },
  );
  return presented(db, updated, admin, present);
});

// The newest report, which bounds the reports a suspension resolves (domain/suspension.ts, remote-suspension.ts), in
// decimal: a report id may pass 2^53 (0054_remote_reports allows 18 digits), so it never becomes a JS number.
export function reportBound(db: Db): string {
  return db.first<{ id: string }>("SELECT CAST(coalesce(max(id), 0) AS TEXT) AS id FROM reports")!.id;
}

// The reporters of the account `target` after the account id `after`, in account id order, at most `limit`, each with
// its reach (AccountReachFinder#reporters_inboxes, app/lib/account_reach_finder.rb:22-23: every reporter of the
// account, whatever its reports' state): a seek of reports_pair_state and a read of the account by key per reporter,
// so a reporter costs two reads however many reports it made. Fewer than `limit` means the walk is done.
export function reachReporters(
  db: Db,
  target: string,
  after: string,
  limit: number,
): (ReachedAccount & { account_id: string })[] {
  const reached: (ReachedAccount & { account_id: string })[] = [];
  let cursor = after;
  while (reached.length < limit) {
    const next = db.first<{ id: string | null }>(
      `SELECT min(account_id) AS id FROM reports INDEXED BY reports_pair_state
			WHERE target_account_id = ?1 AND account_id > ?2`,
      target,
      cursor,
    )?.id;
    if (next == null) {
      break;
    }
    const account = reachAccount(db, next);
    reached.push({ account_id: next, domain: account?.domain ?? null, inbox: account?.inbox ?? null });
    cursor = next;
  }
  return reached;
}

// The newest moderation log row, which a suspension freezes in its transaction: the action bound of the report fence
// (resolveSuspensionReports).
export function actionBound(db: Db): number {
  return db.first<{ id: number | null }>("SELECT max(id) AS id FROM admin_actions")?.id ?? 0;
}

// A suspension-job round (domain/suspension.ts) resolving the target's reports, as Admin::AccountAction
// #process_reports! resolves every unresolved one. Read at most `limit` reports after report id `cursor`, through
// reports_target_state in id order. Resolve only reports frozen at suspension (the report fence, VIS-29 and
// 0042_report_action_fence): filed up to `bound`, still unresolved, and last stamped at or below `fence`, which also
// stamps the reports resolved here. A null `fence` (unknown) resolves none. `by` names the suspending admin (null:
// none). `bound`, `cursor` and the last report returned are report ids in decimal (reportBound). Returns the last
// report read (null if none) and the resolved count; fewer than `limit` read means the range is done.
export function resolveSuspensionReports(
  db: Db,
  target: string,
  bound: string,
  fence: number | null,
  by: string | null,
  cursor: string,
  limit: number,
  now: string,
): { last: string | null; read: number; resolved: number } {
  const rows = db.all<{ id: string; frozen: number }>(
    `SELECT CAST(id AS TEXT) AS id, (?5 IS NOT NULL AND coalesce(last_action_id, 0) <= ?5) AS frozen
		FROM reports INDEXED BY reports_target_state
		WHERE target_account_id = ?1 AND (action_taken_at IS NULL) = 1 AND id > CAST(?2 AS INTEGER)
			AND id <= CAST(?3 AS INTEGER)
		ORDER BY reports.id LIMIT ?4`,
    target,
    cursor,
    bound,
    limit,
    fence,
  );
  const frozen = rows.filter((row) => row.frozen === 1).map((row) => row.id);
  // Each report by its key: an IN over the ids lets statistics older than the Store's growth scan reports (RES-7).
  for (const key of frozen) {
    db.run(
      `UPDATE reports SET action_taken_at = ?1, action_taken_by_account_id = ?2, updated_at = ?1, last_action_id = ?4
			WHERE id = CAST(?3 AS INTEGER)`,
      now,
      by,
      key,
      fence,
    );
  }
  return { last: rows.at(-1)?.id ?? null, read: rows.length, resolved: frozen.length };
}

export type ReportTargetPage =
  | { ok: true; page: string }
  | { ok: false; code: "wrong-authority" | "report-not-found"; message: string };

// GET /admin/reports/:id (the Access admin's, app/admin.ts): the web page of the account report `id` is about (its
// Account entity's url). The Access admin is checked against the saved configuration in this transaction, before the
// report is read (accessAdminRefusal), so a change of the settings while the request was being authenticated refuses
// it; an id that is no report's is not found (Report.find).
export const reportTargetPage = readOperation<
  { authority: ImportAuthority; id: string; origin: string },
  ReportTargetPage
>((db, { authority, id, origin }) => {
  const refused = accessAdminRefusal(db, authority, "only an Access admin opens a report");
  if (refused !== null) {
    return { ok: false, code: "wrong-authority", message: refused };
  }
  const row = /^\d{1,18}$/.test(id)
    ? db.first<{ url: string | null; uri: string; username: string; domain: string | null }>(
        `SELECT a.url, ${actorUriSql("a.uri")} AS uri, ${usernameSql("a.username")} AS username,
					a.domain
				FROM reports r JOIN accounts a ON a.id = r.target_account_id
				WHERE r.id = CAST(? AS INTEGER)`,
        id,
      )
    : undefined;
  return row === undefined
    ? { ok: false, code: "report-not-found", message: "report not found" }
    : { ok: true, page: accountUrl(row, origin) };
});

// Report `id`'s stored status_ids (Admin::AccountAction#status_ids, include_statuses being always true there), by its
// key; undefined when `id` is no report's.
export function reportStatusIds(db: Db, id: string): string | undefined {
  return reportRow(db, id)?.status_ids;
}

// Admin::AccountAction with type none and a report_id (process_reports!): resolves that report, logged as Mastodon logs
// it. false when `id` is no report's.
export function resolveReport(db: Db, id: string, admin: Admin): boolean {
  const row = reportRow(db, id);
  if (row === undefined) {
    return false;
  }
  const now = new Date(admin.now).toISOString();
  writeReport(db, admin, row, ACTIONS.resolve.set(admin, now), now, ACTIONS.resolve.log);
  return true;
}
