import {
  type ApiContext,
  type ApiHandler,
  authorized,
  present,
  requestParams,
  storeCall,
  userCredential,
} from "./context";
import { mastodonError } from "./errors";
import { parseBoolean } from "./params";

// Reports (Mastodon 4.5's Api::V1::ReportsController, app/controllers/api/v1/reports_controller.rb); the Store does
// the work (domain/reports.ts).

// POST /api/v1/reports: account_id, comment, category, forward, forward_to_domains[], status_ids[] and rule_ids[]
// (report_params, reports_controller.rb:25-27).
export const createReport: ApiHandler = async (c, deps) => {
  const p = await requestParams(c, deps);
  if (p instanceof Response) {
    return p;
  }
  const input = {
    credential: userCredential(c, deps),
    account: p.get("account_id") ?? "",
    statusIds: p.getAll("status_ids"),
    comment: p.get("comment"),
    category: p.get("category"),
    ruleIds: p.getAll("rule_ids"),
    forward: parseBoolean(p.get("forward")) === true,
    forwardToDomains: p.has("forward_to_domains") ? p.getAll("forward_to_domains") : null,
    present: present(c),
    now: deps.now(),
  };
  return reportResponse(authorized(await storeCall(c, deps, (s, b) => s.createReport(b, input))), c);
};

// A report operation's answer (domain/reports.ts), the user's or an admin's, as the RPC returns it.
type ReportAnswer =
  | { status: "ok"; report: object }
  | { status: "not_found" }
  | { status: "invalid"; errors: string[] };

export function reportResponse(result: ReportAnswer, c: ApiContext): Response {
  switch (result.status) {
    case "ok":
      return c.json(result.report);
    case "not_found":
      return mastodonError(404, "Record not found");
    case "invalid":
      return mastodonError(422, `Validation failed: ${result.errors.join(", ")}`);
  }
}
