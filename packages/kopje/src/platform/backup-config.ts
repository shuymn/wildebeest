import { Encrypter } from "age-encryption";

// The scheduled backup's settings (docs/backup.md). They are read apart from the main config (config.ts): a missing or
// malformed backup setting must not put the instance into maintenance, it only stops the backup and shows in health.
// Issues name the variable, never its value (DATA-5, DATA-9).

export type BackupConfig = {
  recipients: string[];
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  // Every object the job writes, lists or deletes is under this prefix (ends with '/').
  prefix: string;
  retention: number;
  hourUtc: number;
};

export type BackupConfigResult =
  | { state: "disabled" }
  | { state: "not-configured"; missing: string[] }
  | { state: "invalid"; issues: string[] }
  | { state: "ready"; config: BackupConfig };

// Required to run; everything else has a default.
const REQUIRED = [
  "BACKUP_AGE_RECIPIENT",
  "BACKUP_S3_ENDPOINT",
  "BACKUP_S3_BUCKET",
  "BACKUP_S3_ACCESS_KEY_ID",
  "BACKUP_S3_SECRET_ACCESS_KEY",
] as const;

export const DEFAULT_BACKUP_PREFIX = "kopje-backup/";
export const DEFAULT_RETENTION = 7;
const MAX_RETENTION = 366;
// Path-style S3 bucket names (lowercase DNS-like names, as every S3-compatible service accepts).
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
// Prefix segments: no empty, '.' or '..' segment, so keys stay plain and every listing is bounded by the prefix.
const PREFIX = /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)+$/;
const REGION = /^[a-z0-9-]{1,32}$/;

const parsed = new WeakMap<object, BackupConfigResult>();

function text(env: Record<string, unknown>, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

// Backups are on by default: BACKUP_ENABLED unset (or 'true') with the required settings present runs the job.
export function readBackupConfig(env: object): BackupConfigResult {
  let result = parsed.get(env);
  if (result === undefined) {
    result = parse(env as Record<string, unknown>);
    parsed.set(env, result);
  }
  return result;
}

function parse(env: Record<string, unknown>): BackupConfigResult {
  const enabled = text(env, "BACKUP_ENABLED");
  if (enabled === "false") {
    return { state: "disabled" };
  }
  const issues: string[] = [];
  if (enabled !== undefined && enabled !== "true") {
    issues.push("BACKUP_ENABLED: must be true or false");
  }
  const missing = REQUIRED.filter((name) => text(env, name) === undefined);
  if (missing.length > 0 && issues.length === 0) {
    return { state: "not-configured", missing };
  }

  const recipients = (text(env, "BACKUP_AGE_RECIPIENT") ?? "").split(/[\s,]+/).filter((r) => r !== "");
  for (const recipient of recipients) {
    try {
      new Encrypter().addRecipient(recipient);
    } catch {
      issues.push("BACKUP_AGE_RECIPIENT: must be age public keys (age1...), separated by spaces");
      break;
    }
  }
  const endpoint = text(env, "BACKUP_S3_ENDPOINT") ?? "";
  let origin = "";
  try {
    const url = new URL(endpoint);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("not a plain https URL");
    }
    if (url.pathname !== "/") {
      throw new Error("has a path");
    }
    origin = url.origin;
  } catch {
    issues.push("BACKUP_S3_ENDPOINT: must be an https origin such as https://s3.example.com, without a path");
  }
  const bucket = text(env, "BACKUP_S3_BUCKET") ?? "";
  if (!BUCKET.test(bucket)) {
    issues.push("BACKUP_S3_BUCKET: must be a bucket name of 3-63 lowercase letters, digits, dots or dashes");
  }
  const region = text(env, "BACKUP_S3_REGION") ?? "us-east-1";
  if (!REGION.test(region)) {
    issues.push("BACKUP_S3_REGION: must be a region name such as us-east-1 or auto");
  }
  const prefix = text(env, "BACKUP_S3_PREFIX") ?? DEFAULT_BACKUP_PREFIX;
  if (!PREFIX.test(prefix) || prefix.split("/").some((segment) => segment === ".." || segment === ".")) {
    issues.push(
      "BACKUP_S3_PREFIX: must be path segments of letters, digits, dots, dashes or underscores, ending with /",
    );
  }
  const retention = integer(text(env, "BACKUP_RETENTION"), DEFAULT_RETENTION);
  if (retention === null || retention < 1 || retention > MAX_RETENTION) {
    issues.push(`BACKUP_RETENTION: must be a whole number from 1 to ${MAX_RETENTION}`);
  }
  const hourUtc = integer(text(env, "BACKUP_HOUR_UTC"), 0);
  if (hourUtc === null || hourUtc < 0 || hourUtc > 23) {
    issues.push("BACKUP_HOUR_UTC: must be a whole number from 0 to 23");
  }
  if (issues.length > 0) {
    return { state: "invalid", issues };
  }
  return {
    state: "ready",
    config: {
      recipients,
      endpoint: origin,
      bucket,
      region,
      accessKeyId: text(env, "BACKUP_S3_ACCESS_KEY_ID") ?? "",
      secretAccessKey: text(env, "BACKUP_S3_SECRET_ACCESS_KEY") ?? "",
      prefix,
      retention: retention ?? DEFAULT_RETENTION,
      hourUtc: hourUtc ?? 0,
    },
  };
}

function integer(value: string | undefined, fallback: number): number | null {
  if (value === undefined) {
    return fallback;
  }
  return /^\d{1,4}$/.test(value) ? Number(value) : null;
}
