import type { Db } from "../db/sql";
import { normalizeDomain } from "../platform/domain-name";
import { isRemoteUsername } from "../platform/identity-bounds";
import type { ImportAuthority } from "../platform/store-admin";
import {
  CONTACT_EMAIL_BYTES,
  INSTANCE_DESCRIPTION_LIMIT,
  INSTANCE_DOCUMENT_BYTES,
  INSTANCE_TITLE_LIMIT,
  type InstanceDocument,
  isBlank,
  presentedCountSql,
  settingProjectionSql,
  type StoredSettingName,
  storedSetting,
  storedText,
  trimBlank,
} from "../platform/stored-bounds";
import { remoteHtmlText, sanitizeDocumentHtml } from "../security/html";
import { type Account, accountByAddress, type Present, storedAddress } from "./accounts";
import { accessAdminRefusal } from "./admin-authority";
import { availableLocalSql } from "./audience";
import { forgetActivityAnswer } from "./instance-activity";
import { logAction } from "./moderation-log";
import { readOperation, writeOperation } from "./operation";

// What the instance endpoints show, from instance_settings (the only settings store) and cached counters. The public
// settings are data, not configuration (platform/access-settings.ts CONFIG_KEYS): dumped and imported, erased by a
// reset, written only by the Access admin (setInstanceSettings), and bounded as stored (platform/stored-bounds.ts
// INSTANCE_SETTING_BOUNDS, migration 0049_instance_bounds), so reads take them as stored.

// Mastodon's REST::RuleSerializer: a hint (default "") and the rule's translations by language. Kopje stores no
// translations, so they are always {}.
export type InstanceRule = {
  id: string;
  text: string;
  hint: string;
  translations: Record<string, { text: string; hint: string }>;
};

export type InstanceSettings = {
  domain: string | null;
  title: string | null;
  description: string | null;
  contactEmail: string | null;
  // The stored address of the contact account (contact_username): `username`, or `username@domain`.
  contactUsername: string | null;
  rules: InstanceRule[];
  // Whether the privacy policy and the terms of service are available (documentsOf).
  privacyPolicy: boolean;
  termsOfService: boolean;
};

export type InstanceInfo = InstanceSettings & {
  userCount: number;
  // The available local accounts with an authenticated request on one of the last ACTIVE_DAYS UTC days, today
  // included (local_accounts.active_on, written by auth.ts noteActivity).
  activeMonth: number;
  statusCount: number;
  domainCount: number;
  // The account contact_username names, presented (an unavailable one redacted, VIS-30); null when none is set or
  // it names no account.
  contactAccount: Account | null;
};

// Mastodon's active_month counts the 28 days before today (InstancePresenter#active_user_count); Kopje keeps one day
// per account, so its 28 days are today and the 27 before it.
export const ACTIVE_DAYS = 28;
const DAY_MS = 24 * 60 * 60 * 1000;

// The about page's settings: the extended description as stored (at most INSTANCE_DOCUMENT_BYTES), which the page
// sanitizes at its sink (web/safe-html.ts).
export type AboutSettings = InstanceSettings & { extendedDescription: string | null };

const PUBLIC_SETTINGS = ["domain", "title", "description", "contact_email", "contact_username", "rules"] as const;
// contact_username is read through its stored bound (0059's projection), so a value that bypassed the triggers (a
// BLOB, an over-long text) reads as no contact rather than reaching the parser.
const SETTINGS_QUERY = `SELECT name,
	CASE name WHEN 'contact_username' THEN ${settingProjectionSql("contact_username", "value")} ELSE value END AS value
	FROM instance_settings WHERE name IN (${PUBLIC_SETTINGS.map(() => "?").join(", ")})`;

// A document is available exactly when its row exists, the terms of service when its effective date's row exists too
// (setInstanceSettings writes and removes them together). The writers store no blank document and none that
// sanitizes to no text; one converted by an earlier release that sanitizes to no text stays available, empty.
export function documentsOf(db: Db): Pick<InstanceSettings, "privacyPolicy" | "termsOfService"> {
  const names = new Set(
    db
      .all<{ name: string }>(
        "SELECT name FROM instance_settings WHERE name IN ('privacy_policy', 'terms_of_service', 'terms_of_service_effective_date')",
      )
      .map((row) => row.name),
  );
  return {
    privacyPolicy: names.has("privacy_policy"),
    termsOfService: names.has("terms_of_service") && names.has("terms_of_service_effective_date"),
  };
}

function settingsOf(db: Db): InstanceSettings {
  const settings = new Map(
    db
      .all<{ name: string; value: string | null }>(SETTINGS_QUERY, ...PUBLIC_SETTINGS)
      .flatMap((row) => (row.value === null ? [] : [[row.name, row.value] as const])),
  );
  return {
    domain: settings.get("domain") ?? null,
    title: settings.get("title") ?? null,
    description: settings.get("description") ?? null,
    contactEmail: settings.get("contact_email") ?? null,
    contactUsername: settings.get("contact_username") ?? null,
    rules: parseRules(settings.get("rules")),
    ...documentsOf(db),
  };
}

// The settings alone, without the counters (the about page, domain/web-pages/site.ts).
export function aboutSettingsOf(db: Db): AboutSettings {
  return {
    ...settingsOf(db),
    extendedDescription:
      db.first<{ value: string }>("SELECT value FROM instance_settings WHERE name = 'extended_description'")?.value ??
      null,
  };
}

// The users count and the active ones in the one scan of local_accounts the count needs: active_on between the
// window's first day (?1) and today (?2), so an imported later day never counts (active_on is a CHECKed YYYY-MM-DD, so
// text order is date order).
export const INSTANCE_COUNTS_SQL = `SELECT u.users, u.active,
	(SELECT SUM(${presentedCountSql("statuses_count")}) FROM accounts WHERE domain IS NULL) AS statuses,
	(SELECT COUNT(DISTINCT domain) FROM accounts WHERE domain IS NOT NULL) AS domains
FROM (SELECT COUNT(*) AS users, COUNT(CASE WHEN l.active_on BETWEEN ?1 AND ?2 THEN 1 END) AS active
	FROM local_accounts l WHERE ${availableLocalSql("l")}) u`;

export const instanceInfo = readOperation<{ now: number; present: Present }, InstanceInfo>((db, { now, present }) => {
  const since = new Date(now - (ACTIVE_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  const counts = db.first<{ users: number; active: number; statuses: number | null; domains: number }>(
    INSTANCE_COUNTS_SQL,
    since,
    new Date(now).toISOString().slice(0, 10),
  );
  const settings = settingsOf(db);
  return {
    ...settings,
    userCount: counts?.users ?? 0,
    activeMonth: counts?.active ?? 0,
    statusCount: counts?.statuses ?? 0,
    domainCount: counts?.domains ?? 0,
    contactAccount: contactAccount(db, settings, present),
  };
});

// A contact_username within its bound (read through its projection, or shaped by adminValue) split at its `@`, the
// instance's own domain read as local.
function contactParts(value: string, instanceDomain: string | null): { username: string; domain: string | null } {
  const at = value.indexOf("@");
  const domain = at === -1 ? null : value.slice(at + 1);
  return { username: at === -1 ? value : value.slice(0, at), domain: domain === instanceDomain ? null : domain };
}

export function contactAccount(db: Db, settings: InstanceSettings, present: Present): Account | null {
  if (settings.contactUsername === null) {
    return null;
  }
  const { username, domain } = contactParts(settings.contactUsername, settings.domain);
  return accountByAddress(db, username, domain, present);
}

// GET /api/v1/instance/rules: the rules setting alone, one row, whatever the instance holds.
export const instanceRules = readOperation<void, InstanceRule[]>((db) =>
  parseRules(db.first<{ value: string }>("SELECT value FROM instance_settings WHERE name = 'rules'")?.value),
);

// rules is a JSON array (of at most INSTANCE_RULES_BYTES) of strings or of { id?, text, hint? } objects. Anything
// unreadable shows as no rules, and a hint that is not a string as none.
export function parseRules(value: string | undefined): InstanceRule[] {
  if (value === undefined) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const rules: InstanceRule[] = [];
  for (const [index, rule] of parsed.entries()) {
    const text = typeof rule === "string" ? rule : (rule as { text?: unknown } | null)?.text;
    if (typeof text !== "string" || text === "") {
      continue;
    }
    const { id, hint } = (typeof rule === "object" && rule !== null ? rule : {}) as { id?: unknown; hint?: unknown };
    rules.push({
      id: typeof id === "string" || typeof id === "number" ? String(id) : String(index + 1),
      text,
      hint: typeof hint === "string" ? hint : "",
      translations: {},
    });
  }
  return rules;
}

// RES-3, RES-7: GET /api/v1/instance/peers lists at most this many domains.
export const MAX_PEERS = 10_000;

// The distinct domains of known remote accounts, in order, as Mastodon's Instance.searchable lists them (Kopje has no
// server-wide domain blocks to leave out). Each domain is found by one seek on the (domain, username) index past the
// previous one, so the work grows with the domains returned, never with the accounts known. The same set the
// instance's domain_count counts; it reveals no more than which servers the instance knows of.
export const instancePeers = readOperation<void, string[]>((db) =>
  db
    .all<{ domain: string }>(
      `WITH RECURSIVE peers(domain) AS (
				SELECT (SELECT MIN(domain) FROM accounts WHERE domain IS NOT NULL)
				UNION ALL
				SELECT (SELECT MIN(domain) FROM accounts WHERE domain > peers.domain) FROM peers WHERE peers.domain IS NOT NULL
				LIMIT ?1
			)
			SELECT domain FROM peers WHERE domain IS NOT NULL`,
      MAX_PEERS,
    )
    .map((row) => row.domain),
);

// GET /api/v1/peers/search returns at most this many domains, as Mastodon's Api::V1::Peers::SearchController::LIMIT.
export const PEER_SEARCH_LIMIT = 10;

// The peers (instancePeers' set) whose domain starts with the prefix, in order. The same seek as instancePeers, started
// at the prefix and stopped past it, so it reads at most one row more than it returns.
export const searchPeers = readOperation<{ prefix: string }, string[]>((db, { prefix }) =>
  db
    .all<{ domain: string }>(
      `WITH RECURSIVE peers(domain) AS (
				SELECT (SELECT MIN(domain) FROM accounts WHERE domain >= ?1)
				UNION ALL
				SELECT (SELECT MIN(domain) FROM accounts WHERE domain > peers.domain) FROM peers
				WHERE substr(peers.domain, 1, length(?1)) = ?1
				LIMIT ?2 + 1
			)
			SELECT domain FROM peers WHERE substr(domain, 1, length(?1)) = ?1 LIMIT ?2`,
      prefix,
      PEER_SEARCH_LIMIT,
    )
    .map((row) => row.domain),
);

// ---- The instance's documents: the extended description, the privacy policy and the terms of service (HTML)

// A document as stored, with its stamp (the time an admin write last changed it; none for a converted one) or, for the
// terms of service, its effective date. null when it is not available (documentsOf).
export type InstanceDocumentSource = { text: string; updatedAt: string | null; effectiveDate: string | null };

// The stamped documents' stamps, set by setInstanceSettings with each change of the document.
const STAMPED = {
  extended_description: "extended_description_updated_at",
  privacy_policy: "privacy_policy_updated_at",
};

// The setting that goes with each document: its stamp, or the terms of service's effective date.
const COMPANION: Record<InstanceDocument, string> = { ...STAMPED, terms_of_service: "terms_of_service_effective_date" };

export function documentSource(db: Db, name: InstanceDocument): InstanceDocumentSource | null {
  const companion = COMPANION[name];
  const rows = new Map(
    db
      .all<{ name: string; value: string }>(
        "SELECT name, value FROM instance_settings WHERE name IN (?, ?)",
        name,
        companion,
      )
      .map((row) => [row.name, row.value]),
  );
  const text = rows.get(name);
  if (text === undefined) {
    return null;
  }
  if (name === "terms_of_service") {
    const effectiveDate = rows.get(companion);
    return effectiveDate === undefined ? null : { text, updatedAt: null, effectiveDate };
  }
  return { text, updatedAt: rows.get(companion) ?? null, effectiveDate: null };
}

// The API's presentation (mastodon/instance.ts): the document sanitized once here (HTML-1), by the documents' own
// sanitizer, so its headings reach clients as the pages show them and as Mastodon's Markdown-rendered documents carry
// them. A stored document is at most INSTANCE_DOCUMENT_BYTES, so at most as many UTF-16 code units:
// REMOTE_HTML_RAW_LIMIT never cuts it.
export const instanceDocument = readOperation<{ name: InstanceDocument }, InstanceDocumentSource | null>(
  (db, { name }) => {
    const source = documentSource(db, name);
    return source === null ? null : { ...source, text: sanitizeDocumentHtml(source.text) };
  },
);

// ---- The Access admin's write of the public settings (`kopje-admin instance`, POST /admin/instance)

// The names an admin write sets, in the order GET /admin/instance lists them. rules has no editor; the stamps are
// written with their documents.
export const INSTANCE_ADMIN_NAMES = [
  "title",
  "description",
  "contact_email",
  "contact_username",
  "extended_description",
  "privacy_policy",
  "terms_of_service",
  "terms_of_service_effective_date",
  "show_domain_blocks",
  "show_domain_blocks_rationale",
  "trends",
  "trendable_by_default",
  "activity_api_enabled",
] as const;

type AdminName = (typeof INSTANCE_ADMIN_NAMES)[number];

const SHOWN_NAMES = [...INSTANCE_ADMIN_NAMES, ...Object.values(STAMPED)];

export type InstanceAdminValues = Record<string, string>;

export type SetInstanceSettingsResult =
  | { ok: true; values: InstanceAdminValues }
  | { ok: false; code: "wrong-authority" | "invalid-instance-setting"; message: string };

// Each name read through its stored bound's projection (storedSetting's), so a stored value never shows past it.
function adminValues(db: Db): InstanceAdminValues {
  const projected = SHOWN_NAMES.map(
    (name) => `WHEN '${name}' THEN ${settingProjectionSql(name as StoredSettingName, "value")}`,
  );
  const rows = db.all<{ name: string; value: string | null }>(
    `SELECT name, CASE name ${projected.join(" ")} END AS value FROM instance_settings
		WHERE name IN (${SHOWN_NAMES.map(() => "?").join(", ")})`,
    ...SHOWN_NAMES,
  );
  const values = new Map(rows.flatMap((row) => (row.value === null ? [] : [[row.name, row.value] as const])));
  return Object.fromEntries(SHOWN_NAMES.flatMap((name) => (values.has(name) ? [[name, values.get(name)!]] : [])));
}

// GET /admin/instance: the public settings and the documents' stamps, as stored.
export const instanceAdminSettings = readOperation<void, InstanceAdminValues>((db) => adminValues(db));

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/u;
const ENCODER = new TextEncoder();

// What an admin write stores for `raw`: null to remove, the text otherwise, or why it is refused. The text is
// storedText's output without blank characters at either end, and must be what the name's writer stores unchanged
// (INSTANCE_SETTING_BOUNDS), so the triggers accept it; a document must also leave text once sanitized.
function adminValue(name: AdminName, raw: unknown): string | null | { refused: string } {
  if (raw === null) {
    return null;
  }
  if (typeof raw !== "string") {
    return { refused: `${name} must be a string, or null to remove it` };
  }
  const value = trimBlank(storedText(raw));
  if (value === "") {
    return { refused: `${name} is blank; send null to remove it` };
  }
  switch (name) {
    case "title":
    case "description": {
      const limit = name === "title" ? INSTANCE_TITLE_LIMIT : INSTANCE_DESCRIPTION_LIMIT;
      if ([...value].length > limit) {
        return { refused: `${name} is at most ${limit} characters` };
      }
      break;
    }
    case "contact_email":
      if (ENCODER.encode(value).length > CONTACT_EMAIL_BYTES || !EMAIL_SHAPE.test(value)) {
        return { refused: `contact_email must be an email address of at most ${CONTACT_EMAIL_BYTES} bytes` };
      }
      break;
    case "contact_username": {
      // Mastodon's form: an optional leading @, then user or user@domain (ExistingUsernameValidator); the account is
      // found by setInstanceSettings.
      const parts = value.replace(/^@/, "").split("@");
      const [username = "", domain] = parts;
      const normalized = domain === undefined ? null : normalizeDomain(domain);
      const address = normalized === null ? username : `${username}@${normalized}`;
      if (
        parts.length > 2 ||
        !isRemoteUsername(username) ||
        (domain !== undefined && normalized === null) ||
        storedSetting(name, address) !== address
      ) {
        return { refused: CONTACT_SHAPE };
      }
      return address;
    }
    case "extended_description":
    case "privacy_policy":
    case "terms_of_service":
      if (ENCODER.encode(value).length > INSTANCE_DOCUMENT_BYTES) {
        return { refused: `${name} is at most ${INSTANCE_DOCUMENT_BYTES} bytes of HTML` };
      }
      if (isBlank(remoteHtmlText(sanitizeDocumentHtml(value)))) {
        return { refused: `${name} has no text once sanitized` };
      }
      break;
    case "terms_of_service_effective_date":
      if (storedSetting(name, value) !== value) {
        return { refused: "terms_of_service_effective_date must be a date, YYYY-MM-DD" };
      }
      break;
    case "show_domain_blocks":
    case "show_domain_blocks_rationale":
      if (storedSetting(name, value) !== value) {
        return { refused: `${name} must be disabled, users or all` };
      }
      break;
    case "trends":
    case "trendable_by_default":
    case "activity_api_enabled":
      if (storedSetting(name, value) !== value) {
        return { refused: `${name} must be true or false` };
      }
      break;
  }
  if (storedSetting(name, value) !== value) {
    throw new Error(`${name}: a value the admin write accepts is past its stored bound`);
  }
  return value;
}

const CONTACT_SHAPE = "contact_username must be the address of an account, username or username@domain";

// The stored address of the account a shaped contact_username (adminValue's) names, the instance's own domain read
// as local, or why it is refused. The address is the account's as stored, and must pass the setting's bound unchanged
// (a converted username may not), so the trigger never refuses what is written.
function contactAddress(db: Db, value: string): string | { refused: string } {
  const instanceDomain =
    db.first<{ value: string }>("SELECT value FROM instance_settings WHERE name = 'domain'")?.value ?? null;
  const { username, domain } = contactParts(value, instanceDomain);
  const address = storedAddress(db, username, domain);
  if (address === null) {
    return { refused: "contact_username names no account" };
  }
  return storedSetting("contact_username", address) === address
    ? address
    : { refused: "contact_username names an account whose address cannot be stored" };
}

const DATE = "terms_of_service_effective_date";

// The terms of service and their effective date exist together or not at all (documentsOf), checked on the merged
// state of a request that names either: one request may set both. Removing the text removes the date.
function termsRefusal(
  stored: InstanceAdminValues,
  changes: Map<AdminName, string | null>,
  final: Map<string, string>,
): string | null {
  if (!changes.has("terms_of_service") && !changes.has(DATE)) {
    return null;
  }
  if (changes.get("terms_of_service") === null) {
    final.delete(DATE);
    return null;
  }
  const text = final.has("terms_of_service");
  const date = final.has(DATE);
  if (text && !date) {
    return changes.get(DATE) === null && stored[DATE] !== undefined
      ? "terms_of_service_effective_date cannot be removed while terms_of_service stays; remove terms_of_service"
      : "terms_of_service needs terms_of_service_effective_date";
  }
  if (date && !text) {
    return "no terms_of_service to date";
  }
  return null;
}

// POST /admin/instance (`kopje-admin instance`), Access only (AUTH-5): sets or removes (null) the public settings in
// one transaction, refused whole if any value is. Only the names whose value changes are written and logged
// ('update_setting' or 'remove_setting', target Setting; values are not logged); a document's stamp is set with each
// change of it and removed with it, so an identical resubmission changes nothing (as Mastodon leaves a Setting saved
// with its value), and a converted document stays unstamped until it is edited.
export const setInstanceSettings = writeOperation<
  { authority: ImportAuthority; values: unknown; now: number },
  SetInstanceSettingsResult
>((db, { authority, values, now }) => {
  const refused = accessAdminRefusal(db, authority, "only an Access admin sets the instance settings");
  if (refused !== null || authority.kind !== "access") {
    return {
      ok: false,
      code: "wrong-authority",
      message: refused ?? "only an Access admin sets the instance settings",
    };
  }
  const invalid = (message: string) => ({ ok: false as const, code: "invalid-instance-setting" as const, message });
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    return invalid('expected {"values": {"<name>": string | null}}');
  }
  const changes = new Map<AdminName, string | null>();
  for (const [name, raw] of Object.entries(values)) {
    if (!(INSTANCE_ADMIN_NAMES as readonly string[]).includes(name)) {
      return invalid(`unknown setting ${JSON.stringify(name)}; names: ${INSTANCE_ADMIN_NAMES.join(", ")}`);
    }
    const value = adminValue(name as AdminName, raw);
    if (value !== null && typeof value === "object") {
      return invalid(value.refused);
    }
    changes.set(name as AdminName, value);
  }
  const contact = changes.get("contact_username");
  if (contact !== undefined && contact !== null) {
    const address = contactAddress(db, contact);
    if (typeof address === "object") {
      return invalid(address.refused);
    }
    changes.set("contact_username", address);
  }
  const stored = adminValues(db);
  const final = new Map(Object.entries(stored));
  for (const [name, value] of changes) {
    if (value === null) {
      final.delete(name);
    } else {
      final.set(name, value);
    }
  }
  const terms = termsRefusal(stored, changes, final);
  if (terms !== null) {
    return invalid(terms);
  }
  const at = new Date(now).toISOString();
  for (const name of INSTANCE_ADMIN_NAMES) {
    const value = final.get(name);
    if (value === stored[name]) {
      continue;
    }
    if (value === undefined) {
      db.run("DELETE FROM instance_settings WHERE name = ?", name);
    } else {
      db.run("INSERT OR REPLACE INTO instance_settings (name, value) VALUES (?, ?)", name, value);
    }
    if (name === "activity_api_enabled") {
      // The kept answer of GET /api/v1/instance/activity is made again once the API is back on.
      forgetActivityAnswer(db);
    }
    const stamp = STAMPED[name as keyof typeof STAMPED] as string | undefined;
    if (stamp !== undefined) {
      if (value === undefined) {
        db.run("DELETE FROM instance_settings WHERE name = ?", stamp);
      } else {
        db.run("INSERT OR REPLACE INTO instance_settings (name, value) VALUES (?, ?)", stamp, at);
      }
    }
    logAction(
      db,
      authority,
      value === undefined ? "remove_setting" : "update_setting",
      { type: "Setting", id: name },
      {},
      now,
    );
  }
  return { ok: true, values: adminValues(db) };
});
