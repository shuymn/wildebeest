// The scheduled backup's bookkeeping in the Store (jobs/backup.ts): the run state in kopje_state under 'backup', and
// the media index in backup_media. Nothing here is secret: object keys, upload ids, fingerprints, sizes and digests
// (DATA-9). Neither is part of a dump.
//
// One invocation at a time holds the runner lease. The lease is taken and checked inside the Store transaction, and
// every write below is refused unless the caller still holds it, so an invocation that lost the lease learns so at its
// next step. Its S3 requests already in flight cannot be stopped; they write only objects named for that invocation
// (OPS-5), never the ones another invocation records.

export type Failure = { id: string | null; at: number; stage: string | null; reason: string };

export type Digest = { size: number; sha256: string };

// An encrypted object: its size and digest as stored, and before encryption.
export type ObjectDigest = Digest & { key: string; plaintext: Digest };

// A dump being written: the handles that release its freeze (the Store dump, by opId) and its multipart upload after
// a death. age's stream state cannot be saved, so the object is restarted, never continued.
export type DumpProgress = { opId: string; key: string; uploadId: string | null; parts: number; bytes: number };

export type DumpResult = ObjectDigest & {
  createdAt: string;
  source: { build: string; version: string };
  migrations: { name: string; checksum: string }[];
};

export type Coverage = { required: number; copied: number; pending: number; absent: number };

export type BackupRun = {
  // <UTC date>-<random>: unique per run, and the prefix of every object the run writes.
  id: string;
  startedAt: number;
  // Invocations that died while holding this run, since its last recorded failure.
  attempts: number;
  stage: "dump" | "media" | "index" | "manifest";
  // Fingerprint of the bucket (endpoint, bucket, region, prefix) and the recipients. A run whose fingerprint no longer
  // matches the settings is abandoned, and media copies made under another fingerprint count as missing.
  fingerprint: string;
  // The recipients this run encrypts to, fixed when it starts.
  recipients: string[];
  dump: DumpProgress | null;
  result: DumpResult | null;
  // Originals copied by this run so far; the copy stage stops at a cap and leaves the rest to the next run.
  copied: number;
  index: (ObjectDigest & { coverage: Coverage }) | null;
  manifestAt: number | null;
};

export type BackupState = {
  runner: { id: string; until: number } | null;
  run: BackupRun | null;
  lastSuccess: {
    id: string;
    at: number;
    manifest: string;
    // SHA-256 of the encrypted manifest as uploaded: how an operator tells it from a manifest someone else wrote.
    manifestSha256: string;
    dumpBytes: number;
    coverage: Coverage;
  } | null;
  lastFailure: Failure | null;
  // After a failure, nothing starts again before this time.
  retryAt: number | null;
  retentionFailure: { at: number; reason: string } | null;
};

export const EMPTY_BACKUP_STATE: BackupState = {
  runner: null,
  run: null,
  lastSuccess: null,
  lastFailure: null,
  retryAt: null,
  retentionFailure: null,
};

const NAME = "backup";
// The state no longer grows with the media set (that is backup_media), so this is far above any real record.
const MAX_RECORD_BYTES = 256 * 1024;

export function readBackupState(sql: SqlStorage): BackupState {
  const row = sql.exec<{ value: string }>("SELECT value FROM kopje_state WHERE name = ?", NAME).toArray()[0];
  return row === undefined ? EMPTY_BACKUP_STATE : (JSON.parse(row.value) as BackupState);
}

function writeState(sql: SqlStorage, state: BackupState): void {
  sql.exec("INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)", NAME, JSON.stringify(state));
}

export type Refused = { ok: false; code: "busy" | "lost" | "invalid" | "too-large" };

function holds(state: BackupState, runner: string, now: number): boolean {
  return state.runner !== null && state.runner.id === runner && now < state.runner.until;
}

// Takes the runner lease unless another runner holds it at `now`. `crashed`: the previous holder's lease ran out
// without a release, so that invocation died.
export function claimBackup(
  sql: SqlStorage,
  runner: string,
  now: number,
  leaseMs: number,
): { ok: true; state: BackupState; crashed: boolean } | Refused {
  const state = readBackupState(sql);
  if (state.runner !== null && state.runner.id !== runner && now < state.runner.until) {
    return { ok: false, code: "busy" };
  }
  const next = { ...state, runner: { id: runner, until: now + leaseMs } };
  writeState(sql, next);
  return { ok: true, state: next, crashed: state.runner !== null && state.runner.id !== runner };
}

// Saves the state if `runner` still holds the lease, renewing it (or releasing it). `pruneTo`: a run that just
// succeeded; index rows that run does not need are removed.
export function saveBackup(
  sql: SqlStorage,
  runner: string,
  now: number,
  leaseMs: number,
  value: unknown,
  release: boolean,
  pruneTo: string | null,
): { ok: true; until: number } | Refused {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, code: "invalid" };
  }
  if (!holds(readBackupState(sql), runner, now)) {
    return { ok: false, code: "lost" };
  }
  const until = now + leaseMs;
  const state = { ...(value as BackupState), runner: release ? null : { id: runner, until } };
  if (JSON.stringify(state).length > MAX_RECORD_BYTES) {
    return { ok: false, code: "too-large" };
  }
  writeState(sql, state);
  if (pruneTo !== null) {
    sql.exec("DELETE FROM backup_media WHERE required_run != ?", pruneTo);
  }
  return { ok: true, until };
}

// ---- media index

export type MediaRow = {
  source: string;
  state: "pending" | "copied" | "absent";
  key: string | null;
  size: number | null;
  sha256: string | null;
  plain_size: number | null;
  plain_sha256: string | null;
  copied_run: string | null;
};

// Replaces the run's membership with every original the dump references. It runs in the transaction that completes
// the dump, under its freeze (StoreAdmin.dumpFinish), so the set is exactly the dump's; a restarted dump replaces the
// set of the attempt before it. Rows leaving the set keep their copy metadata for reuse until the next success prunes
// them. Copies made under another destination (bucket and recipients), and originals found absent before, become
// pending again: a new destination gets a full copy, and absence is rechecked.
export function captureMedia(
  sql: SqlStorage,
  runner: string,
  now: number,
  run: string,
  destination: string,
): { ok: true; required: number } | Refused {
  if (!holds(readBackupState(sql), runner, now)) {
    return { ok: false, code: "lost" };
  }
  sql.exec("UPDATE backup_media SET required_run = '' WHERE required_run = ?", run);
  sql.exec(
    `UPDATE backup_media SET state = 'pending', destination = NULL, key = NULL, size = NULL, sha256 = NULL,
		 plain_size = NULL, plain_sha256 = NULL, copied_run = NULL
		 WHERE state = 'absent' OR (state = 'copied' AND destination IS NOT ?)`,
    destination,
  );
  // Completed local uploads: their original is in R2 at originals/<id> (platform/media-files.ts).
  sql.exec(
    `INSERT INTO backup_media (source, required_run, state)
		 SELECT 'originals/' || id, ?, 'pending' FROM media_attachments WHERE file_token IS NOT NULL AND processed = 1
		 ON CONFLICT (source) DO UPDATE SET required_run = excluded.required_run`,
    run,
  );
  const required = sql
    .exec<{ n: number }>("SELECT count(*) AS n FROM backup_media WHERE required_run = ?", run)
    .one().n;
  return { ok: true, required };
}

// A page of the run's index, in source order; `pendingOnly` for the copy stage.
export function mediaPage(
  sql: SqlStorage,
  run: string,
  after: string | null,
  limit: number,
  pendingOnly: boolean,
): MediaRow[] {
  return sql
    .exec<MediaRow>(
      `SELECT source, state, key, size, sha256, plain_size, plain_sha256, copied_run FROM backup_media
			 WHERE required_run = ? AND source > ? ${pendingOnly ? "AND state = 'pending'" : ""}
			 ORDER BY source LIMIT ?`,
      run,
      after ?? "",
      Math.max(1, Math.min(1000, Math.floor(limit))),
    )
    .toArray();
}

export type MediaCopyRecord =
  | { state: "copied"; destination: string; run: string; copy: ObjectDigest }
  | { state: "absent" };

export function recordMedia(
  sql: SqlStorage,
  runner: string,
  now: number,
  source: string,
  record: MediaCopyRecord,
): { ok: true } | Refused {
  if (!holds(readBackupState(sql), runner, now)) {
    return { ok: false, code: "lost" };
  }
  if (record.state === "absent") {
    sql.exec("UPDATE backup_media SET state = 'absent' WHERE source = ?", source);
  } else {
    const { copy } = record;
    sql.exec(
      `UPDATE backup_media SET state = 'copied', destination = ?, key = ?, size = ?, sha256 = ?, plain_size = ?,
			 plain_sha256 = ?, copied_run = ? WHERE source = ?`,
      record.destination,
      copy.key,
      copy.size,
      copy.sha256,
      copy.plaintext.size,
      copy.plaintext.sha256,
      record.run,
      source,
    );
  }
  return { ok: true };
}

export function mediaCoverage(sql: SqlStorage, run: string): Coverage {
  const rows = sql
    .exec<{
      state: MediaRow["state"];
      n: number;
    }>("SELECT state, count(*) AS n FROM backup_media WHERE required_run = ? GROUP BY state", run)
    .toArray();
  const count = (state: MediaRow["state"]) => rows.find((r) => r.state === state)?.n ?? 0;
  const coverage = { copied: count("copied"), pending: count("pending"), absent: count("absent") };
  return { required: coverage.copied + coverage.pending + coverage.absent, ...coverage };
}
