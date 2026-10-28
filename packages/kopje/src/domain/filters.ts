import { selectSql } from "../db/columns";
import type { Db } from "../db/sql";
import { resolveApiId } from "./accounts";
import { canView, type ViewerContext } from "./audience";
import { userReadOperation, userWriteOperation } from "./auth";
import { allocateLocalId } from "./ids";
import { FILTER_MATCH_COLUMNS } from "./status-rows";

// Filters (Mastodon 4.5's CustomFilter, CustomFilterKeyword and CustomFilterStatus, Api::V2::FiltersController and
// its keywords and statuses controllers, and the v1 layer Api::V1::FiltersController over them). A filter belongs to
// a local account; only its owner sees or changes it, its keywords and its statuses: anyone else's is not found.
//
// Filters are not a visibility rule. The read rule (audience.ts) decides what the viewer may see; the presenter then
// reports, in each status's `filtered`, every active filter of the viewer that matches it, whatever its context and
// action (warn, hide, blur), as Mastodon's StatusRelationshipsPresenter does: the client decides by context, and
// nothing is left out on the server. activeFilters reads and compiles the viewer's filters once per presentation, and
// filterStatusMatches seeks the presented statuses in each of them.

// CustomFilter::VALID_CONTEXTS, CustomFilter's action enum, TITLE_LENGTH_LIMIT and
// CustomFilterKeyword::KEYWORD_LENGTH_LIMIT.
export const FILTER_CONTEXTS = ["home", "notifications", "public", "thread", "account"] as const;
export type FilterContext = (typeof FILTER_CONTEXTS)[number];
export const FILTER_ACTIONS = ["warn", "hide", "blur"] as const;
export type FilterAction = (typeof FILTER_ACTIONS)[number];
export const MAX_FILTER_TITLE = 256;
export const MAX_FILTER_KEYWORD = 512;

// Kopje's caps, where Mastodon has none: every presentation to a signed-in viewer compiles their filters and matches
// each status against every keyword (RES-1, RES-7), and GET /api/v2/filters answers every filter
// with its rules (RES-3). Generous for a person's filters: at most 1,000 keywords and 10,000 filtered statuses.
export const MAX_FILTERS = 50;
export const MAX_FILTER_KEYWORDS = 20;
export const MAX_FILTER_STATUSES = 200;

// REST::FilterKeywordSerializer and REST::FilterStatusSerializer.
export type FilterKeyword = { id: string; keyword: string; whole_word: boolean };
export type FilterStatus = { id: string; status_id: string };

// REST::FilterSerializer; keywords and statuses only where the rules are requested (the v2 filter endpoints).
export type Filter = {
  id: string;
  title: string;
  context: string[];
  expires_at: string | null;
  filter_action: FilterAction;
  keywords?: FilterKeyword[];
  statuses?: FilterStatus[];
};

// REST::V1::FilterSerializer: one keyword of a filter.
export type FilterV1 = {
  id: string;
  phrase: string;
  context: string[];
  whole_word: boolean;
  expires_at: string | null;
  irreversible: boolean;
};

// REST::FilterResultSerializer.
export type FilterResult = { filter: Filter; keyword_matches: string[] | null; status_matches: string[] | null };

type FilterRow = { id: string; title: string; context: string; action: FilterAction; expires_at: string | null };
type KeywordRow = { id: string; filter_id: string; keyword: string; whole_word: number };
type StatusRow = { id: string; filter_id: string; status_id: string };

const FILTER_COLUMNS = "f.id, f.title, f.context, f.action, f.expires_at";
const KEYWORD_COLUMNS = "k.id, k.filter_id, k.keyword, k.whole_word";

function presentFilter(row: FilterRow): Filter {
  return {
    id: row.id,
    title: row.title,
    context: JSON.parse(row.context) as string[],
    expires_at: row.expires_at,
    filter_action: row.action,
  };
}

function presentKeyword(row: KeywordRow): FilterKeyword {
  return { id: row.id, keyword: row.keyword, whole_word: row.whole_word === 1 };
}

function presentFilterStatus(row: StatusRow): FilterStatus {
  return { id: row.id, status_id: row.status_id };
}

function presentV1(filter: FilterRow, keyword: KeywordRow): FilterV1 {
  return {
    id: keyword.id,
    phrase: keyword.keyword,
    context: JSON.parse(filter.context) as string[],
    whole_word: keyword.whole_word === 1,
    expires_at: filter.expires_at,
    irreversible: filter.action === "hide",
  };
}

function ownFilter(db: Db, ownerId: string, id: string): FilterRow | undefined {
  return db.first<FilterRow>(
    `SELECT ${FILTER_COLUMNS} FROM filters f WHERE f.id = ? AND f.account_id = ?`,
    id,
    ownerId,
  );
}

// The keyword `id` and its filter, if the filter is the owner's.
function ownKeyword(db: Db, ownerId: string, id: string): { filter: FilterRow; keyword: KeywordRow } | undefined {
  const keyword = db.first<KeywordRow>(`SELECT ${KEYWORD_COLUMNS} FROM filter_keywords k WHERE k.id = ?`, id);
  const filter = keyword === undefined ? undefined : ownFilter(db, ownerId, keyword.filter_id);
  return keyword === undefined || filter === undefined ? undefined : { filter, keyword };
}

// The rules of each filter of filterIds, in their order, each filter's in id order: sought through the filter's
// index from the ids, never scanned with the other accounts' rules (RES-7).
function keywordsOf(db: Db, filterIds: readonly string[]): KeywordRow[] {
  return db.all<KeywordRow>(
    `SELECT ${KEYWORD_COLUMNS} FROM json_each(?1) j
		CROSS JOIN filter_keywords k INDEXED BY filter_keywords_filter ON k.filter_id = j.value
		ORDER BY j.key, k.id`,
    JSON.stringify(filterIds),
  );
}

function statusesOf(db: Db, filterIds: readonly string[]): StatusRow[] {
  return db.all<StatusRow>(
    `SELECT fs.id, fs.filter_id, fs.status_id FROM json_each(?1) j
		CROSS JOIN filter_statuses fs INDEXED BY filter_statuses_pair ON fs.filter_id = j.value
		ORDER BY j.key, fs.id`,
    JSON.stringify(filterIds),
  );
}

// The owner's filters, oldest first.
function ownFilters(db: Db, ownerId: string): FilterRow[] {
  return db.all<FilterRow>(`SELECT ${FILTER_COLUMNS} FROM filters f WHERE f.account_id = ? ORDER BY f.id`, ownerId);
}

// Filters with their keywords and statuses (rules_requested), in the order of `rows`.
function withRules(db: Db, rows: FilterRow[]): Filter[] {
  const ids = rows.map((row) => row.id);
  const keywords = keywordsOf(db, ids);
  const statuses = statusesOf(db, ids);
  return rows.map((row) => ({
    ...presentFilter(row),
    keywords: keywords.filter((k) => k.filter_id === row.id).map(presentKeyword),
    statuses: statuses.filter((s) => s.filter_id === row.id).map(presentFilterStatus),
  }));
}

// Ruby's String#blank?: empty or whitespace only.
function blank(text: string | undefined): boolean {
  return text === undefined || /^\s*$/u.test(text);
}

// Ruby counts characters (code points), not UTF-16 units.
function characters(text: string): number {
  return [...text].length;
}

// CustomFilter's normalization of context: each stripped, blanks dropped; then, where Mastodon keeps repeats, each
// once, so the stored list is at most the five contexts (any other value is refused).
function normalizeContext(context: readonly string[]): string[] {
  return [...new Set(context.map((c) => c.trim()).filter((c) => c !== ""))];
}

// Expireable#expires_in=: a blank interval is no expiry; anything else is Ruby's to_i (a leading integer, else 0) in
// seconds from now. Undefined for a time beyond what a Date holds.
function expiresAt(expiresIn: string, now: string): string | null | undefined {
  if (blank(expiresIn)) {
    return null;
  }
  const seconds = Number(/^\s*[+-]?\d+/.exec(expiresIn)?.[0] ?? "0");
  const at = new Date(Date.parse(now) + seconds * 1000);
  return Number.isNaN(at.getTime()) || at.getUTCFullYear() > 9999 ? undefined : at.toISOString();
}

const INVALID_DATE = "Invalid date supplied";

export type FilterError =
  | { status: "not_found" }
  // A validation failure: Rails' messages, answered as "Validation failed: ..." with 422.
  | { status: "invalid"; errors: string[] }
  // Any other refusal, answered with 422 and the message as it is (Mastodon::ValidationError, Date::Error).
  | { status: "refused"; error: string };

export type FilterOutcome<T> = { status: "ok"; value: T } | FilterError;

// The attributes of a filter a create or an update sets; undefined leaves one as it is (on create: its default).
export type FilterChanges = { title?: string; context?: string[]; filterAction?: string; expiresIn?: string };

// A keywords_attributes entry as sent: each field undefined when absent.
export type KeywordAttributes = { id?: string; keyword?: string; wholeWord?: string; destroy?: string };

// Rails' boolean casting: blank is nil, "0", "f", "false" and "off" (any case) are false, anything else is true.
function castBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  return !["0", "f", "false", "off"].includes(value.toLowerCase());
}

// The filter's attributes after `changes`, and its own validation errors in the order Mastodon runs them (the action
// enum, then title and context presence, title length, the contexts). `keywordErrors` are those of the nested
// keywords, which run between the enum and the presence checks (accepts_nested_attributes_for is declared between).
type FilterState = { title: string; context: string[]; action: FilterAction; expiresAt: string | null };

function filterState(
  current: FilterState,
  changes: FilterChanges,
  now: string,
): { state: FilterState; errors: string[] } | { refused: string } {
  const errors: string[] = [];
  let action = current.action;
  if (changes.filterAction !== undefined) {
    if ((FILTER_ACTIONS as readonly string[]).includes(changes.filterAction)) {
      action = changes.filterAction as FilterAction;
    } else {
      errors.push("Action is not included in the list");
    }
  }
  let expires = current.expiresAt;
  if (changes.expiresIn !== undefined) {
    const at = expiresAt(changes.expiresIn, now);
    if (at === undefined) {
      return { refused: INVALID_DATE };
    }
    expires = at;
  }
  const title = changes.title ?? current.title;
  const context = changes.context === undefined ? current.context : normalizeContext(changes.context);
  return { state: { title, context, action, expiresAt: expires }, errors };
}

function stateErrors(state: FilterState): string[] {
  const errors: string[] = [];
  if (blank(state.title)) {
    errors.push("Title can't be blank");
  }
  if (state.context.length === 0) {
    errors.push("Context can't be blank");
  }
  if (characters(state.title) > MAX_FILTER_TITLE) {
    errors.push(`Title is too long (maximum is ${MAX_FILTER_TITLE} characters)`);
  }
  if (state.context.length === 0 || state.context.some((c) => !(FILTER_CONTEXTS as readonly string[]).includes(c))) {
    errors.push("Context None or invalid context supplied");
  }
  return errors;
}

// CustomFilterKeyword's validations, with the prefix nested attributes give them ("Keywords keyword ...").
function keywordErrors(keyword: string, prefix: string): string[] {
  const errors: string[] = [];
  if (blank(keyword)) {
    errors.push(`${prefix} can't be blank`);
  }
  if (characters(keyword) > MAX_FILTER_KEYWORD) {
    errors.push(`${prefix} is too long (maximum is ${MAX_FILTER_KEYWORD} characters)`);
  }
  return errors;
}

const TOO_MANY_FILTERS = "You have reached the maximum number of filters";
const TOO_MANY_KEYWORDS = "You have reached the maximum number of keywords for this filter";
const TOO_MANY_STATUSES = "You have reached the maximum number of statuses for this filter";

function filterCount(db: Db, ownerId: string): number {
  return db.first<{ n: number }>("SELECT count(*) AS n FROM filters WHERE account_id = ?", ownerId)?.n ?? 0;
}

function keywordCount(db: Db, filterId: string): number {
  return db.first<{ n: number }>("SELECT count(*) AS n FROM filter_keywords WHERE filter_id = ?", filterId)?.n ?? 0;
}

// What keywords_attributes does to a filter's keywords (accepts_nested_attributes_for with reject_if: :all_blank and
// allow_destroy): an entry without an id adds a keyword unless it is all blank or marked _destroy; an entry with an id
// changes or, marked _destroy, deletes that keyword of the filter, and an id the filter does not have is not found.
type KeywordPlan = {
  add: { keyword: string; wholeWord: boolean }[];
  change: { id: string; keyword: string; wholeWord: boolean }[];
  remove: string[];
};

function planKeywords(
  existing: readonly KeywordRow[],
  attributes: readonly KeywordAttributes[],
): { plan: KeywordPlan; errors: string[] } | null {
  const plan: KeywordPlan = { add: [], change: [], remove: [] };
  const errors: string[] = [];
  const byId = new Map(existing.map((k) => [k.id, k]));
  // The entries naming an existing keyword, merged by id in input order as Rails assigns each to the same record: a
  // later field wins, and _destroy, once set, stays.
  const merged = new Map<string, { keyword?: string; wholeWord?: string; destroy: boolean }>();
  for (const entry of attributes) {
    const destroy = castBoolean(entry.destroy) === true;
    if (blank(entry.id)) {
      const allBlank = blank(entry.keyword) && blank(entry.wholeWord);
      if (destroy || allBlank) {
        continue;
      }
      const keyword = entry.keyword ?? "";
      errors.push(...keywordErrors(keyword, "Keywords keyword"));
      plan.add.push({ keyword, wholeWord: castBoolean(entry.wholeWord) ?? true });
      continue;
    }
    const row = byId.get(entry.id ?? "");
    if (row === undefined) {
      return null;
    }
    const changes = merged.get(row.id) ?? { destroy: false };
    merged.set(row.id, {
      keyword: entry.keyword ?? changes.keyword,
      wholeWord: entry.wholeWord ?? changes.wholeWord,
      destroy: changes.destroy || destroy,
    });
  }
  for (const [id, changes] of merged) {
    const row = byId.get(id)!;
    if (changes.destroy) {
      plan.remove.push(id);
      continue;
    }
    const keyword = changes.keyword ?? row.keyword;
    errors.push(...keywordErrors(keyword, "Keywords keyword"));
    plan.change.push({ id, keyword, wholeWord: castBoolean(changes.wholeWord) ?? row.whole_word === 1 });
  }
  const kept = existing.length - plan.remove.length + plan.add.length;
  if (plan.add.length > 0 && kept > MAX_FILTER_KEYWORDS) {
    errors.push(TOO_MANY_KEYWORDS);
  }
  return { plan, errors };
}

function applyKeywords(db: Db, filterId: string, plan: KeywordPlan, now: string): void {
  for (const id of plan.remove) {
    db.run("DELETE FROM filter_keywords WHERE id = ? AND filter_id = ?", id, filterId);
  }
  for (const change of plan.change) {
    db.run(
      "UPDATE filter_keywords SET keyword = ?, whole_word = ? WHERE id = ? AND filter_id = ?",
      change.keyword,
      change.wholeWord ? 1 : 0,
      change.id,
      filterId,
    );
  }
  for (const add of plan.add) {
    insertKeyword(db, filterId, add.keyword, add.wholeWord, now);
  }
}

function updateKeyword(db: Db, id: string, keyword: string, wholeWord: boolean): void {
  db.run("UPDATE filter_keywords SET keyword = ?, whole_word = ? WHERE id = ?", keyword, wholeWord ? 1 : 0, id);
}

function insertKeyword(db: Db, filterId: string, keyword: string, wholeWord: boolean, now: string): KeywordRow {
  const row = db.first<KeywordRow>(
    `INSERT INTO filter_keywords (id, filter_id, keyword, whole_word, created_at) VALUES (?, ?, ?, ?, ?)
		RETURNING id, filter_id, keyword, whole_word`,
    allocateLocalId(db, Date.parse(now)),
    filterId,
    keyword,
    wholeWord ? 1 : 0,
    now,
  );
  if (row === undefined) {
    throw new Error("the filter keyword was not written");
  }
  return row;
}

function insertFilter(db: Db, ownerId: string, state: FilterState, now: string): FilterRow {
  const row = db.first<FilterRow>(
    `INSERT INTO filters (id, account_id, title, context, action, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
		RETURNING id, title, context, action, expires_at`,
    allocateLocalId(db, Date.parse(now)),
    ownerId,
    state.title,
    JSON.stringify(state.context),
    state.action,
    state.expiresAt,
    now,
  );
  if (row === undefined) {
    throw new Error("the filter was not written");
  }
  return row;
}

function updateFilterRow(db: Db, id: string, state: FilterState): void {
  db.run(
    "UPDATE filters SET title = ?, context = ?, action = ?, expires_at = ? WHERE id = ?",
    state.title,
    JSON.stringify(state.context),
    state.action,
    state.expiresAt,
    id,
  );
}

function stateOf(row: FilterRow): FilterState {
  return {
    title: row.title,
    context: JSON.parse(row.context) as string[],
    action: row.action,
    expiresAt: row.expires_at,
  };
}

const NEW_FILTER: FilterState = { title: "", context: [], action: "warn", expiresAt: null };

// GET /api/v2/filters: the viewer's filters, oldest first, with their keywords and statuses.
export const listFilters = userReadOperation<object, Filter[]>((db, _input, { accountId }) =>
  withRules(db, ownFilters(db, accountId)),
);

// GET /api/v2/filters/:id.
export const getFilter = userReadOperation<{ id: string }, Filter | null>((db, { id }, { accountId }) => {
  const row = ownFilter(db, accountId, id);
  return row === undefined ? null : (withRules(db, [row])[0] ?? null);
});

export type FilterInput = FilterChanges & { keywords: KeywordAttributes[] };

// POST /api/v2/filters (current_account.custom_filters.create!): action defaults to warn, no expiry.
export const createFilter = userWriteOperation<FilterInput, FilterOutcome<Filter>>(
  (db, input, _viewer, { accountId, now }) => {
    const next = filterState(NEW_FILTER, input, now);
    if ("refused" in next) {
      return { status: "refused", error: next.refused };
    }
    const keywords = planKeywords([], input.keywords);
    if (keywords === null) {
      return { status: "not_found" };
    }
    const errors = [...next.errors, ...keywords.errors, ...stateErrors(next.state)];
    if (filterCount(db, accountId) >= MAX_FILTERS) {
      errors.push(TOO_MANY_FILTERS);
    }
    if (errors.length > 0) {
      return { status: "invalid", errors };
    }
    const row = insertFilter(db, accountId, next.state, now);
    applyKeywords(db, row.id, keywords.plan, now);
    return { status: "ok", value: withRules(db, [row])[0]! };
  },
);

// PUT /api/v2/filters/:id (@filter.update!): what is sent changes, the rest stays.
export const updateFilter = userWriteOperation<FilterInput & { id: string }, FilterOutcome<Filter>>(
  (db, input, _viewer, { accountId, now }) => {
    const row = ownFilter(db, accountId, input.id);
    if (row === undefined) {
      return { status: "not_found" };
    }
    const next = filterState(stateOf(row), input, now);
    if ("refused" in next) {
      return { status: "refused", error: next.refused };
    }
    const keywords = planKeywords(keywordsOf(db, [row.id]), input.keywords);
    if (keywords === null) {
      return { status: "not_found" };
    }
    const errors = [...next.errors, ...keywords.errors, ...stateErrors(next.state)];
    if (errors.length > 0) {
      return { status: "invalid", errors };
    }
    updateFilterRow(db, row.id, next.state);
    applyKeywords(db, row.id, keywords.plan, now);
    return { status: "ok", value: withRules(db, [ownFilter(db, accountId, row.id)!])[0]! };
  },
);

// DELETE /api/v2/filters/:id: the filter, its keywords and its statuses (ON DELETE CASCADE). Whether it was the
// viewer's.
export const deleteFilter = userWriteOperation<{ id: string }, boolean>(
  (db, { id }, { accountId }) => db.run("DELETE FROM filters WHERE id = ? AND account_id = ?", id, accountId) > 0,
);

// GET /api/v2/filters/:filter_id/keywords: oldest first. Null when the filter is not the viewer's.
export const listFilterKeywords = userReadOperation<{ filterId: string }, FilterKeyword[] | null>(
  (db, { filterId }, { accountId }) => {
    const filter = ownFilter(db, accountId, filterId);
    return filter === undefined ? null : keywordsOf(db, [filter.id]).map(presentKeyword);
  },
);

export type KeywordChanges = { keyword?: string; wholeWord?: string };

// POST /api/v2/filters/:filter_id/keywords: whole_word defaults to true.
export const createFilterKeyword = userWriteOperation<
  KeywordChanges & { filterId: string },
  FilterOutcome<FilterKeyword>
>((db, input, _viewer, { accountId, now }) => {
  const filter = ownFilter(db, accountId, input.filterId);
  if (filter === undefined) {
    return { status: "not_found" };
  }
  const keyword = input.keyword ?? "";
  const errors = keywordErrors(keyword, "Keyword");
  if (keywordCount(db, filter.id) >= MAX_FILTER_KEYWORDS) {
    errors.push(TOO_MANY_KEYWORDS);
  }
  if (errors.length > 0) {
    return { status: "invalid", errors };
  }
  const row = insertKeyword(db, filter.id, keyword, castBoolean(input.wholeWord) ?? true, now);
  return { status: "ok", value: presentKeyword(row) };
});

// GET /api/v2/filters/keywords/:id.
export const getFilterKeyword = userReadOperation<{ id: string }, FilterKeyword | null>((db, { id }, { accountId }) => {
  const own = ownKeyword(db, accountId, id);
  return own === undefined ? null : presentKeyword(own.keyword);
});

// PUT /api/v2/filters/keywords/:id: what is sent changes, the rest stays.
export const updateFilterKeyword = userWriteOperation<KeywordChanges & { id: string }, FilterOutcome<FilterKeyword>>(
  (db, input, { accountId }) => {
    const own = ownKeyword(db, accountId, input.id);
    if (own === undefined) {
      return { status: "not_found" };
    }
    const keyword = input.keyword ?? own.keyword.keyword;
    const errors = keywordErrors(keyword, "Keyword");
    if (errors.length > 0) {
      return { status: "invalid", errors };
    }
    const wholeWord = castBoolean(input.wholeWord) ?? own.keyword.whole_word === 1;
    updateKeyword(db, own.keyword.id, keyword, wholeWord);
    return { status: "ok", value: { id: own.keyword.id, keyword, whole_word: wholeWord } };
  },
);

// DELETE /api/v2/filters/keywords/:id. Whether it was the viewer's.
export const deleteFilterKeyword = userWriteOperation<{ id: string }, boolean>((db, { id }, { accountId }) => {
  const own = ownKeyword(db, accountId, id);
  return own !== undefined && db.run("DELETE FROM filter_keywords WHERE id = ?", own.keyword.id) > 0;
});

// GET /api/v2/filters/:filter_id/statuses: oldest first, each by its status id only, whether or not the viewer may
// still see the status (REST::FilterStatusSerializer). Null when the filter is not the viewer's.
export const listFilterStatuses = userReadOperation<{ filterId: string }, FilterStatus[] | null>(
  (db, { filterId }, { accountId }) => {
    const filter = ownFilter(db, accountId, filterId);
    return filter === undefined ? null : statusesOf(db, [filter.id]).map(presentFilterStatus);
  },
);

// POST /api/v2/filters/:filter_id/statuses: a status the viewer may see (CustomFilterStatus#validate_status_access,
// StatusPolicy#show?), once per filter. A status the viewer may not see is refused as one that does not exist is
// ("Status must exist"), so the two cannot be told apart; Mastodon answers "Status is invalid" for the first.
export const createFilterStatus = userWriteOperation<
  { filterId: string; statusId?: string },
  FilterOutcome<FilterStatus>
>((db, input, _viewer, { accountId, now }) => {
  const filter = ownFilter(db, accountId, input.filterId);
  if (filter === undefined) {
    return { status: "not_found" };
  }
  const statusId = blank(input.statusId) ? null : resolveApiId(db, "statuses", input.statusId ?? "");
  if (statusId === null || !canView(db, accountId, statusId)) {
    return { status: "invalid", errors: ["Status must exist"] };
  }
  const errors: string[] = [];
  if (db.first("SELECT 1 AS x FROM filter_statuses WHERE filter_id = ? AND status_id = ?", filter.id, statusId)) {
    errors.push("Status has already been taken");
  }
  const count =
    db.first<{ n: number }>("SELECT count(*) AS n FROM filter_statuses WHERE filter_id = ?", filter.id)?.n ?? 0;
  if (count >= MAX_FILTER_STATUSES) {
    errors.push(TOO_MANY_STATUSES);
  }
  if (errors.length > 0) {
    return { status: "invalid", errors };
  }
  const row = db.first<StatusRow>(
    `INSERT INTO filter_statuses (id, filter_id, status_id, created_at) VALUES (?, ?, ?, ?)
			RETURNING id, filter_id, status_id`,
    allocateLocalId(db, Date.parse(now)),
    filter.id,
    statusId,
    now,
  );
  if (row === undefined) {
    throw new Error("the filter status was not written");
  }
  return { status: "ok", value: presentFilterStatus(row) };
});

// The filter status `id`, if its filter is the owner's.
function ownFilterStatus(db: Db, ownerId: string, id: string): StatusRow | undefined {
  return db.first<StatusRow>(
    `SELECT fs.id, fs.filter_id, fs.status_id FROM filter_statuses fs JOIN filters f ON f.id = fs.filter_id
		WHERE fs.id = ? AND f.account_id = ?`,
    id,
    ownerId,
  );
}

// GET /api/v2/filters/statuses/:id.
export const getFilterStatus = userReadOperation<{ id: string }, FilterStatus | null>((db, { id }, { accountId }) => {
  const row = ownFilterStatus(db, accountId, id);
  return row === undefined ? null : presentFilterStatus(row);
});

// DELETE /api/v2/filters/statuses/:id. Whether it was the viewer's.
export const deleteFilterStatus = userWriteOperation<{ id: string }, boolean>((db, { id }, { accountId }) => {
  const row = ownFilterStatus(db, accountId, id);
  return row !== undefined && db.run("DELETE FROM filter_statuses WHERE id = ?", row.id) > 0;
});

// The v1 API (Api::V1::FiltersController): each keyword of the viewer's filters is a v1 filter.

function ownKeywords(db: Db, ownerId: string): { filter: FilterRow; keyword: KeywordRow }[] {
  const filters = ownFilters(db, ownerId);
  const byId = new Map(filters.map((f) => [f.id, f]));
  return keywordsOf(
    db,
    filters.map((f) => f.id),
  )
    .map((keyword) => ({ filter: byId.get(keyword.filter_id)!, keyword }))
    .toSorted((a, b) => (a.keyword.id < b.keyword.id ? -1 : a.keyword.id > b.keyword.id ? 1 : 0));
}

// GET /api/v1/filters: every keyword of the viewer's filters, by keyword id.
export const listFiltersV1 = userReadOperation<object, FilterV1[]>((db, _input, { accountId }) =>
  ownKeywords(db, accountId).map(({ filter, keyword }) => presentV1(filter, keyword)),
);

// GET /api/v1/filters/:id.
export const getFilterV1 = userReadOperation<{ id: string }, FilterV1 | null>((db, { id }, { accountId }) => {
  const own = ownKeyword(db, accountId, id);
  return own === undefined ? null : presentV1(own.filter, own.keyword);
});

// What a v1 create or update sends: phrase is both the filter's title and the keyword (filter_params and
// keyword_params), irreversible the filter's action (hide or warn).
export type FilterV1Changes = {
  phrase?: string;
  context?: string[];
  irreversible?: string;
  wholeWord?: string;
  expiresIn?: string;
};

function v1FilterChanges(input: FilterV1Changes): FilterChanges {
  const irreversible = castBoolean(input.irreversible);
  return {
    title: input.phrase,
    context: input.context,
    expiresIn: input.expiresIn,
    ...(input.irreversible === undefined ? {} : { filterAction: irreversible === true ? "hide" : "warn" }),
  };
}

// POST /api/v1/filters: a filter titled by the phrase, with the phrase as its one keyword.
export const createFilterV1 = userWriteOperation<FilterV1Changes, FilterOutcome<FilterV1>>(
  (db, input, _viewer, { accountId, now }) => {
    const next = filterState(NEW_FILTER, v1FilterChanges(input), now);
    if ("refused" in next) {
      return { status: "refused", error: next.refused };
    }
    const errors = [...next.errors, ...stateErrors(next.state)];
    if (filterCount(db, accountId) >= MAX_FILTERS) {
      errors.push(TOO_MANY_FILTERS);
    }
    if (errors.length > 0) {
      return { status: "invalid", errors };
    }
    const phrase = input.phrase ?? "";
    const keywordErrorsFound = keywordErrors(phrase, "Keyword");
    if (keywordErrorsFound.length > 0) {
      return { status: "invalid", errors: keywordErrorsFound };
    }
    const filter = insertFilter(db, accountId, next.state, now);
    const keyword = insertKeyword(db, filter.id, phrase, castBoolean(input.wholeWord) ?? true, now);
    return { status: "ok", value: presentV1(filter, keyword) };
  },
);

const DEPRECATED_MULTIPLE_KEYWORDS =
  "These parameters cannot be changed from this application because they apply to more than one filter keyword. Use a more recent application or the web interface.";

function sameState(a: FilterState, b: FilterState): boolean {
  return (
    a.title === b.title &&
    a.action === b.action &&
    a.expiresAt === b.expiresAt &&
    JSON.stringify(a.context) === JSON.stringify(b.context)
  );
}

// PUT /api/v1/filters/:id: the keyword first (phrase, whole_word), then its filter (title, context, expiry, action),
// which may change only when it has this keyword alone.
export const updateFilterV1 = userWriteOperation<FilterV1Changes & { id: string }, FilterOutcome<FilterV1>>(
  (db, input, _viewer, { accountId, now }) => {
    const own = ownKeyword(db, accountId, input.id);
    if (own === undefined) {
      return { status: "not_found" };
    }
    const phrase = input.phrase ?? own.keyword.keyword;
    const keywordErrorsFound = keywordErrors(phrase, "Keyword");
    if (keywordErrorsFound.length > 0) {
      return { status: "invalid", errors: keywordErrorsFound };
    }
    const current = stateOf(own.filter);
    const next = filterState(current, v1FilterChanges(input), now);
    if ("refused" in next) {
      return { status: "refused", error: next.refused };
    }
    if (!sameState(current, next.state) && keywordCount(db, own.filter.id) > 1) {
      return { status: "refused", error: DEPRECATED_MULTIPLE_KEYWORDS };
    }
    const errors = [...next.errors, ...stateErrors(next.state)];
    if (errors.length > 0) {
      return { status: "invalid", errors };
    }
    const wholeWord = castBoolean(input.wholeWord) ?? own.keyword.whole_word === 1;
    updateKeyword(db, own.keyword.id, phrase, wholeWord);
    updateFilterRow(db, own.filter.id, next.state);
    return {
      status: "ok",
      value: presentV1(ownFilter(db, accountId, own.filter.id)!, {
        ...own.keyword,
        keyword: phrase,
        whole_word: wholeWord ? 1 : 0,
      }),
    };
  },
);

// DELETE /api/v1/filters/:id: the keyword (Api::V1::FiltersController#destroy destroys the CustomFilterKeyword), and
// then its filter if that leaves it with no keyword and no status. Mastodon keeps such a filter, which no v1 request
// can see or delete again; Kopje deletes it, so v1 creates and deletes do not use up MAX_FILTERS. Whether the keyword
// was the viewer's.
export const deleteFilterV1 = userWriteOperation<{ id: string }, boolean>((db, { id }, { accountId }) => {
  const own = ownKeyword(db, accountId, id);
  if (own === undefined || db.run("DELETE FROM filter_keywords WHERE id = ?", own.keyword.id) === 0) {
    return false;
  }
  db.run(
    `DELETE FROM filters WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM filter_keywords WHERE filter_id = ?1)
			AND NOT EXISTS (SELECT 1 FROM filter_statuses WHERE filter_id = ?1)`,
    own.filter.id,
  );
  return true;
});

// Applying filters.

// A filter compiled for matching: its keywords as one pattern (Regexp.union of CustomFilterKeyword#to_regex), or null
// when it has none. hasStatuses: whether the filter names any status (CustomFilterStatus), wherever it is.
type CompiledFilter = { filter: Filter; keywords: RegExp | null; hasStatuses: boolean };

// The viewer's filters that have not expired, compiled once per request.
export type ActiveFilters = { readonly filters: readonly CompiledFilter[] };

// Onigmo's [[:word:]] for Unicode strings (UTS #18's \w): Alphabetic, marks, decimal numbers, connector punctuation
// and join controls. Whether a keyword starts or ends with one decides its boundaries, and the lookarounds use it as
// Ruby's \b.
const WORD_CLASS = "[\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\p{Join_Control}]";
const WORD = new RegExp(WORD_CLASS, "u");

// A keyword as CustomFilterKeyword#to_regex builds it: the escaped literal, case-insensitive (simple Unicode case
// folding, the iu flags), and for whole_word a word boundary where the keyword starts or ends with a word character,
// written as lookarounds over WORD_CLASS (Ruby's \b for Unicode text). A literal with no quantifier cannot backtrack.
// Ruby's /i also applies multi-character folds (ß with ss, İ with i̇); the iu flags do not, and Kopje leaves them.
function keywordSource(row: KeywordRow): string {
  const chars = [...row.keyword];
  const whole = row.whole_word === 1;
  const start = whole && WORD.test(chars[0] ?? "") ? `(?<!${WORD_CLASS})` : "";
  const end = whole && WORD.test(chars.at(-1) ?? "") ? `(?!${WORD_CLASS})` : "";
  return `${start}${row.keyword.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")}${end}`;
}

function compileKeywords(rows: readonly KeywordRow[]): RegExp | null {
  return rows.length === 0 ? null : new RegExp(rows.map((row) => `(?:${keywordSource(row)})`).join("|"), "giu");
}

// The viewer's active filters (CustomFilter.cached_filters_for): unexpired at the request's time, whatever their context
// and action, with their keywords compiled; read once per presentation. Null for an anonymous viewer or none.
export function activeFilters(db: Db, viewer: ViewerContext): ActiveFilters | null {
  if (viewer.accountId === null) {
    return null;
  }
  const rows = db.all<FilterRow & { has_statuses: number }>(
    `SELECT ${FILTER_COLUMNS}, EXISTS (SELECT 1 FROM filter_statuses fs WHERE fs.filter_id = f.id) AS has_statuses
		FROM filters f WHERE f.account_id = ?1 AND (f.expires_at IS NULL OR f.expires_at > ?2)
		ORDER BY f.id`,
    viewer.accountId,
    viewer.now,
  );
  if (rows.length === 0) {
    return null;
  }
  const keywords = keywordsOf(
    db,
    rows.map((row) => row.id),
  );
  return {
    filters: rows.map((row) => ({
      filter: presentFilter(row),
      keywords: compileKeywords(keywords.filter((k) => k.filter_id === row.id)),
      hasStatuses: row.has_statuses === 1,
    })),
  };
}

// The filters among `active` that name each of `statusIds` (CustomFilterStatus), by status id: one seek per filter
// and status through filter_statuses_pair, so the rows read follow the page, not what other filters name.
export function filterStatusMatches(
  db: Db,
  active: ActiveFilters,
  statusIds: readonly string[],
): Map<string, Set<string>> {
  const matches = new Map<string, Set<string>>();
  const filterIds = active.filters.flatMap((f) => (f.hasStatuses ? [f.filter.id] : []));
  if (statusIds.length === 0 || filterIds.length === 0) {
    return matches;
  }
  const rows = db.all<{ filter_id: string; status_id: string }>(
    `SELECT ${selectSql(FILTER_MATCH_COLUMNS.columns)} FROM json_each(?1) f CROSS JOIN json_each(?2) s
			CROSS JOIN filter_statuses fs INDEXED BY filter_statuses_pair ON fs.filter_id = f.value AND fs.status_id = s.value`,
    JSON.stringify(filterIds),
    JSON.stringify(statusIds),
  );
  for (const row of rows) {
    const set = matches.get(row.status_id) ?? new Set<string>();
    set.add(row.filter_id);
    matches.set(row.status_id, set);
  }
  return matches;
}

// Kopje's bound on the text matched, where Mastodon matches all of it: each status's searchable text is cut to
// MAX_FILTER_TEXT code units, and the statuses of one response (the quoted statuses shown in it included) share
// MAX_FILTER_REQUEST_TEXT. When their cut texts fit, each is matched whole; otherwise each is matched on its beginning
// up to one level, the highest at which the response stays within the budget (water-filling: short statuses whole,
// long ones on the same share). A response of 40 statuses (20 with a quoted status each) is always matched whole; a
// keyword deep in a long status of a very large response may be missed. Filter statuses match whatever the text: they
// need none. With the keyword caps, a response compares at most MAX_FILTER_REQUEST_TEXT code units of text with each
// keyword. The level is computed from each status's stored figure (statuses.filter_text_units, the bound of
// migration 0079_filter_text_units), else from an upper bound of its text (status-presenter.ts filterTextBoundSql),
// so an unmeasured status may be cut where its whole text would fit; each cut is also bounded by what is left of
// MAX_FILTER_REQUEST_TEXT, so the budget holds whatever the figures (docs/mastodon-deviations.md).
export { FILTER_TEXT_UNITS_MAX as MAX_FILTER_TEXT } from "../platform/stored-bounds";
export const MAX_FILTER_REQUEST_TEXT = 400_000;

// For texts of `lengths` code units (each already cut to MAX_FILTER_TEXT), how many of each are matched.
export function filterTextLimits(lengths: readonly number[]): number[] {
  const level = filterTextLevel(lengths);
  return lengths.map((length) => Math.min(length, level));
}

// The level filterTextLimits cuts every text at: Infinity when the texts fit MAX_FILTER_REQUEST_TEXT whole. It depends
// on the lengths alone, so an answer presented in chunks applies one level computed over all its candidates.
export function filterTextLevel(lengths: readonly number[]): number {
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (total <= MAX_FILTER_REQUEST_TEXT) {
    return Infinity;
  }
  const sorted = [...lengths].toSorted((a, b) => a - b);
  let remaining = MAX_FILTER_REQUEST_TEXT;
  for (let i = 0; i < sorted.length; i++) {
    const length = sorted[i] ?? 0;
    const fair = Math.floor(remaining / (sorted.length - i));
    if (length > fair) {
      return fair;
    }
    remaining -= length;
  }
  return 0;
}

// What a status is matched by: its text (Status#searchable_text, of the boosted original for a boost, as much of it as
// filterTextLimits gives), and the ids
// filter statuses may name (the status and, for a boost, its original).
// `text` is the matched text up to `cut` code units, followed, when the text was cut, by the code point after the cut,
// read only as the boundary after a match: a match must end by `cut`.
export type FilterTarget = { text: string; cut: number; ids: readonly string[] };

// CustomFilter.apply_cached_filters: for each active filter, the first keyword match (the leftmost in the text, the
// earlier keyword at the same place, as Regexp.union finds it) and the ids of the target a filter status names. A
// filter that names statuses, none of them these, reports [] for status_matches when a keyword matched; one that names
// none reports null.
export function applyFilters(
  active: ActiveFilters,
  statusMatches: ReadonlyMap<string, ReadonlySet<string>>,
  target: FilterTarget,
): FilterResult[] {
  const results: FilterResult[] = [];
  for (const { filter, keywords, hasStatuses } of active.filters) {
    let keywordMatches: string[] | null = null;
    if (keywords !== null) {
      // The leftmost match that ends by the cut. One crossing it starts before the cut, within a keyword's length of
      // it, so the search goes on from the next code point (a whole one: the u flag moves a lastIndex inside a
      // surrogate pair back to its start) and stops at the cut, where no match can end by it.
      keywords.lastIndex = 0;
      for (let match = keywords.exec(target.text); match !== null; match = keywords.exec(target.text)) {
        if (match.index + match[0].length <= target.cut) {
          keywordMatches = [match[0]];
          break;
        }
        if (match.index >= target.cut) {
          break;
        }
        keywords.lastIndex = match.index + ((target.text.codePointAt(match.index) ?? 0) > 0xffff ? 2 : 1);
      }
    }
    const named = target.ids.filter((id) => statusMatches.get(id)?.has(filter.id) === true);
    const statusMatchesOut = named.length > 0 ? named : hasStatuses && keywordMatches !== null ? [] : null;
    if (keywordMatches === null && named.length === 0) {
      continue;
    }
    results.push({ filter, keyword_matches: keywordMatches, status_matches: statusMatchesOut });
  }
  return results;
}
