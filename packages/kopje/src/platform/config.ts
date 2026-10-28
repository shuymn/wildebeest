import * as v from "valibot";

import { MAINTENANCE_MODES } from "./maintenance";
import { vapidPrivateJwk, vapidPublicKey } from "./vapid";

// The least positive REMOTE_MEDIA_CACHE_BYTES: 256 MiB, above the cache's reclamation headroom (96 MiB,
// domain/remote-media.ts LANE1_HEADROOM, which test/remote-media.test.ts compares).
export const REMOTE_MEDIA_CACHE_MIN_BYTES = 256 * 1024 * 1024;
// MEDIA_CACHE_RETENTION_DAYS when unset: Mastodon's media_cache_retention_period default.
export const MEDIA_CACHE_RETENTION_DEFAULT_DAYS = 14;
export const MEDIA_CACHE_RETENTION_MAX_DAYS = 36_500;

// Issues name the field and the problem, never the value, which valibot's default messages quote: each check carries
// its own message, worded as the issues read when config was parsed with zod.
function typeName(value: unknown): string {
  if (typeof value === "number") {
    return Number.isFinite(value) ? "number" : String(value);
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) !== Object.prototype && value.constructor) {
    return value.constructor.name;
  }
  return typeof value;
}

const text = () => v.string((issue) => `Invalid input: expected string, received ${typeName(issue.input)}`);

const nonEmptyText = () => v.pipe(text(), v.minLength(1, "Too small: expected string to have >=1 characters"));

// A variable read as Number(value) that must be a safe integer of at least min. A value that is not a finite integer
// has that one issue; each further bound it fails, here or in a pipe around it, adds its own.
function integer(min: number) {
  return v.pipe(
    v.unknown(),
    // Number() throws for a symbol, or for an object (a JSON binding) that has no primitive value; that is the type
    // issue, against the value as set.
    v.rawTransform(({ dataset, addIssue, NEVER }) => {
      try {
        return Number(dataset.value);
      } catch {
        addIssue({ message: `Invalid input: expected number, received ${typeName(dataset.value)}` });
        return NEVER;
      }
    }),
    v.custom<number>(Number.isInteger, (issue) =>
      typeof issue.input === "number" && Number.isFinite(issue.input)
        ? "Invalid input: expected int, received number"
        : `Invalid input: expected number, received ${typeName(issue.input)}`,
    ),
    v.minValue(Number.MIN_SAFE_INTEGER, `Too small: expected int to be >=${Number.MIN_SAFE_INTEGER}`),
    v.maxValue(Number.MAX_SAFE_INTEGER, `Too big: expected int to be <=${Number.MAX_SAFE_INTEGER}`),
    v.minValue(min, `Too small: expected number to be >=${min}`),
  );
}

const atMost = (max: number) => v.maxValue<number, number, string>(max, `Too big: expected number to be <=${max}`);

function binding<T>(name: string) {
  return v.custom<T>((value) => typeof value === "object" && value !== null, `binding ${name} is missing`);
}

// Bindings come from wrangler.jsonc (typed by `wrangler types`). MAINTENANCE and the secrets are set outside the
// config file, so they are validated here instead. MAINTENANCE lives outside the Store because PITR rewinds it.
const configSchema = v.object(
  {
    STORE: binding<Env["STORE"]>("STORE"),
    QUEUE: binding<Env["QUEUE"]>("QUEUE"),
    MEDIA: binding<Env["MEDIA"]>("MEDIA"),
    IMAGES: binding<Env["IMAGES"]>("IMAGES"),
    ASSETS: binding<Env["ASSETS"]>("ASSETS"),
    CF_VERSION_METADATA: binding<Env["CF_VERSION_METADATA"]>("CF_VERSION_METADATA"),
    MAINTENANCE: v.optional(
      v.picklist(
        MAINTENANCE_MODES,
        `Invalid option: expected one of ${MAINTENANCE_MODES.map((mode) => `"${mode}"`).join("|")}`,
      ),
      "off",
    ),
    SETUP_TOKEN: v.optional(nonEmptyText()),
    // One-time secret for the cutover import into an empty Store (app/admin.ts); removed after the import.
    IMPORT_TOKEN: v.optional(nonEmptyText()),
    // The KEK that wraps local private keys. Unset reads as the empty string, which is a legal KEK (healthReport
    // warns).
    USER_KEK: v.optional(text()),
    // The KEK the local keys were wrapped with before USER_KEK changed, read only by `kopje-admin keys rewrap`
    // (app/key-rewrap.ts). Unset reads as the empty string, like USER_KEK; removed once the rewrap has passed.
    USER_KEK_PREVIOUS: v.optional(text()),
    // Images transformations uploads may reserve per UTC month (TRANSFORMS_PER_UPLOAD, three, per upload or profile
    // image; a custom emoji or rebuilt media row as domain/media.ts says). The default stays under the 5,000 the
    // Images free plan includes; an operator with paid transformations raises it in the dashboard.
    IMAGES_MONTHLY_TRANSFORMS: v.optional(integer(0), 4000),
    // Each local account's share of it per month, so one account cannot lock the others out. Unset: a tenth of
    // IMAGES_MONTHLY_TRANSFORMS (accountMonthlyTransforms).
    IMAGES_ACCOUNT_MONTHLY_TRANSFORMS: v.optional(integer(0)),
    // Images transformations link card images may start per UTC month (up to two each, apart from
    // IMAGES_MONTHLY_TRANSFORMS; federation/card-images.ts). 0, the default, fetches and re-encodes none; the sum with
    // IMAGES_MONTHLY_TRANSFORMS is what the account's Images allowance must cover (docs/setup.md).
    IMAGES_CARD_MONTHLY_TRANSFORMS: v.optional(integer(0), 0),
    // The bytes the cache of remote media (domain/remote-media.ts, MEDIA-7) may charge in the media bucket under
    // remote/, reservations and files awaiting deletion included; reclamation keeps it below. 4 GiB by default; 0 turns
    // caching off; a positive value below REMOTE_MEDIA_CACHE_MIN_BYTES, which leaves reclamation no room above its
    // headroom, is a configuration error (requests answer 503 and the cron does nothing, as for any invalid variable).
    REMOTE_MEDIA_CACHE_BYTES: v.optional(
      v.pipe(
        integer(0),
        atMost(Number.MAX_SAFE_INTEGER),
        v.check(
          (value) => value === 0 || value >= REMOTE_MEDIA_CACHE_MIN_BYTES,
          `must be 0 or at least ${REMOTE_MEDIA_CACHE_MIN_BYTES}`,
        ),
      ),
      4 * 1024 * 1024 * 1024,
    ),
    // Days a cached remote attachment is kept (Mastodon's media_cache_retention_period); 0 keeps them within the cap.
    // Profile images are kept while their account shows them.
    MEDIA_CACHE_RETENTION_DAYS: v.optional(
      v.pipe(integer(0), atMost(MEDIA_CACHE_RETENTION_MAX_DAYS)),
      MEDIA_CACHE_RETENTION_DEFAULT_DAYS,
    ),
    // Rolling a cutover back (docs/cutover-runbook.md): 'journal' makes the Queue consumer keep every spooled inbox
    // request in the Store's rollback journal, for `kopje-admin cutover drain` to hand to the legacy instance.
    CUTOVER_ROLLBACK: v.optional(v.picklist(["journal"], 'Invalid input: expected "journal"')),
    // Lower quotas for the rollback journal than the Store's own maxima (platform/store-admin.ts).
    CUTOVER_JOURNAL_MAX_ENTRIES: v.optional(integer(1)),
    CUTOVER_JOURNAL_MAX_BYTES: v.optional(integer(1)),
    // For that drain only: the legacy instance's VAPID_JWK, which its inbox messages carry.
    LEGACY_VAPID_JWK: v.optional(nonEmptyText()),
    // Web Push's key, set by the operator and never generated (DATA-2): Web Push is unavailable without it.
    VAPID_JWK: v.optional(
      v.pipe(
        text(),
        v.check((value) => vapidPublicKey(value) !== null, "must be an EC P-256 private key JWK"),
      ),
    ),
  },
  // Every variable is optional, so a missing key is a binding: valibot reports it on the object without running the
  // binding's own check.
  (issue) => `binding ${String(issue.path?.[0]?.key)} is missing`,
);

export type Config = v.InferOutput<typeof configSchema>;

// The effective KEK: an unset USER_KEK reads as the empty string, which is a legal KEK.
export function userKek(config: Config): string {
  return config.USER_KEK ?? "";
}

// The KEK a rewrap moves keys from: an unset USER_KEK_PREVIOUS reads as the empty string, as USER_KEK does.
export function previousUserKek(config: Config): string {
  return config.USER_KEK_PREVIOUS ?? "";
}

// The default share is a tenth of the instance budget: Kopje serves up to about ten local accounts.
export const ACCOUNT_SHARE_DIVISOR = 10;

export function accountMonthlyTransforms(config: Config): number {
  return (
    config.IMAGES_ACCOUNT_MONTHLY_TRANSFORMS ?? Math.floor(config.IMAGES_MONTHLY_TRANSFORMS / ACCOUNT_SHARE_DIVISOR)
  );
}

export type ConfigResult = { ok: true; config: Config } | { ok: false; issues: string[] };

const parsed = new WeakMap<object, ConfigResult>();

// Validates env once per env object. Issues name the field and the problem, never the value.
export function readConfig(env: object): ConfigResult {
  let result = parsed.get(env);
  if (result === undefined) {
    const parse = v.safeParse(configSchema, env);
    result = parse.success
      ? { ok: true, config: parse.output }
      : { ok: false, issues: parse.issues.map((issue) => `${v.getDotPath(issue) ?? ""}: ${issue.message}`) };
    parsed.set(env, result);
  }
  return result;
}

// The VAPID keys when Web Push is available: VAPID_JWK is set (an invalid one fails readConfig, and the gate answers
// 503, DATA-2). jwk signs VAPID tokens and seals push tokens; publicKey is the server_key clients subscribe with.
export function webPushKeys(env: object): { jwk: JsonWebKey; publicKey: string } | null {
  const config = readConfig(env);
  const secret = config.ok ? config.config.VAPID_JWK : undefined;
  const jwk = secret === undefined ? null : vapidPrivateJwk(secret);
  const publicKey = secret === undefined ? null : vapidPublicKey(secret);
  return jwk === null || publicKey === null ? null : { jwk, publicKey };
}
