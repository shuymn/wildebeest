// `kopje-admin cutover-preflight`: finds a legacy instance's resources from its Pages project, and lists what the
// cutover needs on both sides (docs/cutover-runbook.md, "Before the cutover").
//
// It reads a file only: the Pages project as the Cloudflare API returns it (GET .../pages/projects/<name>, saved by the
// operator; the runbook gives the command). It never calls an API itself. Resources are found from the project's
// bindings, never guessed by name, so a renamed or upstream-era instance is read as it is. Secret values are never in
// that answer and never printed; variables are listed by name and type, except DOMAIN, which is public. With
// --export, the export's migration level and the KEK check come from the converter's loader (DATA-14).

import { readFileSync } from "node:fs";

import { checkSizes, exportFiles } from "./export-files.js";
import { checkKeks } from "./kek.js";
import { loadLegacyExport } from "./legacy-load.js";
import { ExportError } from "./sql-script.js";

export const SPOOL_QUEUE_BINDING = "KOPJE_QUEUE";
const KEK_NAMES = ["userKEK", "USER_KEY"];

/** @typedef {{ id: string, status: 'pass' | 'warn' | 'fail' | 'todo', message: string }} Check */

/** @param {unknown} value */
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/**
 * The bindings of one deployment environment, by kind.
 * @param {Record<string, any>} config
 */
function bindingsOf(config) {
  /** @param {string} field @param {string} idField */
  const map = (field, idField) =>
    Object.entries(record(config[field])).map(([binding, value]) => ({ binding, id: record(value)[idField] ?? null }));
  return {
    d1: map("d1_databases", "id"),
    queues: map("queue_producers", "name"),
    durableObjects: map("durable_object_namespaces", "namespace_id"),
    kv: map("kv_namespaces", "namespace_id"),
    r2: map("r2_buckets", "name"),
    services: map("services", "service"),
    vars: Object.entries(record(config.env_vars)).map(([name, value]) => ({
      name,
      type: typeof record(value).type === "string" ? record(value).type : "unknown",
    })),
    compatibilityDate: typeof config.compatibility_date === "string" ? config.compatibility_date : null,
    compatibilityFlags: Array.isArray(config.compatibility_flags) ? config.compatibility_flags : [],
  };
}

/**
 * @param {unknown} json the saved API answer ({ result: project }) or the project itself
 * @param {{ domain?: string | undefined, kopjeQueue?: string | undefined }} [options]
 */
export function readPagesProject(json, { domain, kopjeQueue } = {}) {
  const project = record(record(json).result ?? json);
  const configs = record(project.deployment_configs);
  if (typeof project.name !== "string" || Object.keys(record(configs.production)).length === 0) {
    throw new ExportError("not-a-pages-project");
  }
  const production = bindingsOf(record(configs.production));
  const preview = bindingsOf(record(configs.preview));
  const vars = record(record(configs.production).env_vars);
  const domainVar = record(vars.DOMAIN);
  const legacyDomain = domainVar.type === "plain_text" && typeof domainVar.value === "string" ? domainVar.value : null;
  const customDomains = Array.isArray(project.domains) ? project.domains.filter((d) => typeof d === "string") : [];
  const source = record(project.source);
  const sourceConfig = record(source.config);

  /** @type {Check[]} */
  const checks = [];
  /** @param {Check['id']} id @param {Check['status']} status @param {string} message */
  const check = (id, status, message) => checks.push({ id, status, message });

  const database = production.d1.find((b) => b.binding === "DATABASE");
  check(
    "legacy-d1",
    database === undefined ? "fail" : "pass",
    database === undefined
      ? "no production D1 binding named DATABASE; this is not a supported legacy instance"
      : "the legacy D1 is the production DATABASE binding: export, fingerprint and drain read this database",
  );
  const previewDatabase = preview.d1.find((b) => b.binding === "DATABASE");
  if (previewDatabase !== undefined && database !== undefined && previewDatabase.id === database.id) {
    check(
      "preview-writes-legacy-d1",
      "warn",
      "preview deployments bind the same D1: every preview and deployment URL must be closed in step 3",
    );
  }
  const legacyQueue = production.queues.find((b) => b.binding === "QUEUE");
  check(
    "legacy-queue",
    legacyQueue === undefined ? "warn" : "pass",
    legacyQueue === undefined
      ? "no QUEUE producer binding: no legacy Queue to drain (steps 2 and 4 are skipped)"
      : "the legacy Queue gets a dead-letter queue in step 2 and is drained in step 4",
  );
  const spool = production.queues.find((b) => b.binding === SPOOL_QUEUE_BINDING);
  if (spool === undefined) {
    check("spool-binding", "todo", `add a Queue producer binding ${SPOOL_QUEUE_BINDING} to Kopje's Queue (production)`);
  } else if (kopjeQueue !== undefined && spool.id !== kopjeQueue) {
    check("spool-binding", "fail", `${SPOOL_QUEUE_BINDING} is bound to another Queue than --kopje-queue`);
  } else if (legacyQueue !== undefined && spool.id === legacyQueue.id) {
    check("spool-binding", "fail", `${SPOOL_QUEUE_BINDING} is bound to the legacy Queue`);
  } else {
    check(
      "spool-binding",
      kopjeQueue === undefined ? "warn" : "pass",
      kopjeQueue === undefined
        ? `${SPOOL_QUEUE_BINDING} is bound; pass --kopje-queue to check it is Kopje's Queue`
        : `${SPOOL_QUEUE_BINDING} is bound to Kopje's Queue`,
    );
  }
  if (legacyDomain === null) {
    check("domain", "fail", "no plain-text DOMAIN variable in production");
  } else if (domain !== undefined && legacyDomain.toLowerCase() !== domain.toLowerCase()) {
    check("domain", "fail", "DOMAIN differs from --domain");
  } else {
    check("domain", "pass", "Kopje takes DOMAIN as it is: set the same domain on the Kopje Store");
  }
  if (legacyDomain !== null && !customDomains.some((d) => d.toLowerCase() === legacyDomain.toLowerCase())) {
    check("custom-domain", "warn", "DOMAIN is not among the project custom domains; find where it is routed");
  }
  const keks = production.vars.filter((v) => KEK_NAMES.includes(v.name)).map((v) => v.name);
  check(
    "kek-candidates",
    keks.length > 1 ? "warn" : "pass",
    keks.length === 0
      ? "no KEK secret: the keys are wrapped with the empty KEK unless the export check says otherwise"
      : `KEK secrets present: ${keks.join(", ")}; set the one that unwraps every key as USER_KEK on Kopje`,
  );
  // The maintenance worker refuses inbox requests when it cannot read Kopje's Queue backlog (it fails closed); only a
  // run on the project's own runtime shows whether it can.
  check(
    "queue-metrics",
    "todo",
    "in the rehearsal, check that the maintenance worker reads Kopje's Queue metrics on this project (a signed POST to a preview deployment answers 202, not 503)",
  );
  if (Object.keys(source).length > 0 && sourceConfig.deployments_enabled !== false) {
    check("git-deployments", "todo", "the project builds from Git: pause its automatic deployments in step 1");
  }

  // The write barrier (docs/cutover-runbook.md): everything here that can write the legacy D1, and what closes it.
  // The tools see only this project's configuration; the runbook asks for the rest (other Workers bound to the D1).
  /** @type {{ writer: string, close: string }[]} */
  const barrier = [];
  if (database !== undefined) {
    barrier.push({
      writer: "production deployments (custom domain, pages.dev, every deployment URL)",
      close: "step 3: the maintenance worker becomes the production deployment; older deployment URLs are closed",
    });
  }
  if (preview.d1.some((b) => b.id !== null && database !== undefined && b.id === database.id)) {
    barrier.push({
      writer: "preview deployments (they bind the same D1)",
      close: "before step 3: remove the DATABASE binding from the preview environment, and delete preview deployments",
    });
  }
  if (legacyQueue !== undefined) {
    barrier.push({
      writer: `the consumer of the legacy Queue (${String(legacyQueue.id)})`,
      close: "step 4: after draining, remove it from the Queue (wrangler queues consumer remove)",
    });
  }
  for (const service of production.services) {
    barrier.push({
      writer: `the Worker bound as ${service.binding} (${String(service.id)})`,
      close: "check whether it binds the D1; if it does, stop it before step 5",
    });
  }
  if (Object.keys(source).length > 0 && sourceConfig.deployments_enabled !== false) {
    barrier.push({ writer: "Pages Git builds", close: "step 1: pause automatic deployments" });
  }
  barrier.push({
    writer: "deploy and backup workflows, and any other Worker or job bound to the D1",
    close: "step 1: disable them; list other Workers bound to the D1 in the dashboard (D1, the database, Bindings)",
  });

  return {
    project: {
      name: project.name,
      subdomain: typeof project.subdomain === "string" ? project.subdomain : null,
      productionBranch: typeof project.production_branch === "string" ? project.production_branch : null,
      customDomains,
      gitIntegration: Object.keys(source).length > 0,
    },
    domain: legacyDomain,
    production,
    preview,
    kekCandidates: keks,
    barrier,
    checks,
  };
}

/**
 * @param {{ projectPath: string, exportPath?: string | undefined, domain?: string | undefined,
 *   kopjeQueue?: string | undefined,
 *   env: Record<string, string | undefined> }} options
 */
export async function preflight({ projectPath, exportPath, domain, kopjeQueue, env }) {
  const project = readPagesProject(/** @type {unknown} */ (JSON.parse(readFileSync(projectPath, "utf8"))), {
    domain,
    kopjeQueue,
  });
  const checks = [...project.checks];
  /** @type {Record<string, unknown> | null} */
  let exported = null;
  if (exportPath !== undefined) {
    const files = exportFiles(exportPath);
    checkSizes(files);
    const { db, report: source } = loadLegacyExport({
      texts: files.map((file) => () => readFileSync(file, "utf8")),
      acceptDeletions: true,
    });
    const users = /** @type {any[]} */ (
      db.prepare("SELECT actor_id, privkey, privkey_salt, pubkey FROM users ORDER BY rowid").all()
    ).map((u) => ({ uri: String(u.actor_id), privkey: u.privkey, salt: u.privkey_salt, pubkey: String(u.pubkey) }));
    db.close();
    const kek = await checkKeks(users, env);
    exported = {
      level: source.level,
      levelName: source.levelName,
      line: source.line,
      localUsers: users.length,
      deletions: source.deletions,
      kek: { candidates: kek.candidates, uniform: kek.uniform, kek: kek.kek, emptyKek: kek.emptyKek },
    };
    checks.push({
      id: "kek-uniform",
      status: kek.uniform ? "pass" : "fail",
      message: kek.uniform
        ? `one KEK (${kek.kek}) unwraps every local key`
        : "no single KEK candidate unwraps every key; set userKEK or USER_KEY in the environment and run again",
    });
  }
  return {
    ...project,
    checks,
    ...(exported === null ? {} : { export: exported }),
    kopje: [
      "deploy Kopje (deploy/ template) with MAINTENANCE=full and USER_KEK set to the KEK the export check names",
      "add the Worker on an admin hostname, with an Access application for /admin there (later also <domain>/admin)",
      "set a one-time IMPORT_TOKEN secret; with it set the domain and the Access values, then delete it (the import and any rollback go through Access); never run /setup",
      `bind Kopje's Queue to the Pages project as ${SPOOL_QUEUE_BINDING} (production)`,
      "create Kopje's Queue dead-letter queue; for a rollback, bind the legacy Queue and its dead-letter queue to Kopje as LEGACY_QUEUE and LEGACY_DLQ, and set LEGACY_VAPID_JWK",
    ],
    ok: !checks.some((check) => check.status === "fail"),
  };
}
