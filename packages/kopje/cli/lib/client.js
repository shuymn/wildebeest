/* global fetch */
// HTTP client of the admin API (/admin/*). Credentials go only into request headers; nothing here ever formats them
// into a message.

export class AdminError extends Error {
  /**
   * @param {string} message
   * @param {number} status HTTP status, or 0 when the request itself failed
   * @param {string | null} code the API's error code
   * @param {Record<string, unknown>} body
   */
  constructor(message, status, code, body) {
    super(message);
    this.name = "AdminError";
    this.status = status;
    this.code = code;
    this.body = body;
  }

  // Worth retrying: the request failed in transit or the server had a transient problem.
  get transient() {
    return (
      this.status === 0 || this.status === 502 || this.status === 503 || this.status === 504 || this.status === 500
    );
  }
}

/**
 * A parsed JSON response of the admin API.
 * @typedef {Record<string, unknown>} Json
 * The dump's position, which the Store hands out and takes back; the CLI reads only these fields.
 * @typedef {{ dump: string, phase: string, table: number }} DumpCursor
 * @typedef {{ id: string, state: string, lastSeq: number, digest: string, headerSha256: string,
 *   trailerSha256: string | null, report: Json }} ImportProgress
 * The responses whose fields the CLI reads (src/app/admin.ts serves them), by path; any other is printed as it is.
 * @typedef {{
 *   "/admin/health": { ok: boolean },
 *   "/admin/capacity": { databaseSize: number, tables: { name: string, rows: number }[] },
 *   "/admin/deliveries/retry": { retried: number, refused: number, skipped: number, more: boolean,
 *     next: string | null },
 *   "/admin/jobs/retry": { reset: number, more: boolean },
 *   "/admin/media/rebuild": { counts: Record<string, number>, problems: unknown[], stopped: string | null,
 *     done: boolean, next: string | null },
 *   "/admin/keys/rewrap": { counts: { rewrapped: number, current: number, failed: number }, failures: unknown[],
 *     done: boolean, next: string | null },
 *   "/admin/dump/start": { cursor: DumpCursor, headerLine: string, header: { tables: unknown[] } },
 *   "/admin/dump/finish": { trailerText: string },
 *   "/admin/import/begin": { progress: ImportProgress, session?: string, resumed: boolean },
 *   "/admin/import/progress": { progress: ImportProgress | null },
 *   "/admin/import/chunk": { duplicate: boolean, progress: ImportProgress },
 *   "/admin/import/verify": { done: boolean, progress: ImportProgress, report: Json },
 *   "/admin/import/reset": { done?: boolean },
 *   "/admin/cutover/drain": { sent: number, unverified: number, noRecipient: number,
 *     journal: { pending: number, sending: number }, stopped: string | null, waiting: string | null },
 *   "/admin/cutover/reset": { done?: boolean, id: string | null },
 * }} Responses
 * @typedef {(input: string, init?: RequestInit) => Promise<Response>} Fetch
 * @typedef {{
 *   accessClientId?: string | undefined,
 *   accessClientSecret?: string | undefined,
 *   importToken?: string | undefined,
 *   importSession?: string,
 * }} Credentials
 */

/**
 * @template {string} P
 * @typedef {P extends keyof Responses ? Responses[P] : Json} ResponseOf
 */

/**
 * @param {{ url: string, credentials: Credentials, fetch?: Fetch | undefined }} options
 */
export function createClient({ url, credentials, fetch: fetchImpl = (input, init) => fetch(input, init) }) {
  const base = new URL(url);
  if (base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1") {
    throw new Error("the admin URL must use https");
  }
  /** @type {Record<string, string>} */
  const auth = {};
  if (credentials.accessClientId !== undefined && credentials.accessClientSecret !== undefined) {
    auth["CF-Access-Client-Id"] = credentials.accessClientId;
    auth["CF-Access-Client-Secret"] = credentials.accessClientSecret;
  }
  // An import session replaces the import token: after begin, a token import is continued only with its session.
  if (credentials.importSession !== undefined) {
    auth["Kopje-Import-Session"] = credentials.importSession;
  } else if (credentials.importToken !== undefined) {
    auth["Kopje-Import-Token"] = credentials.importToken;
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {{ json?: unknown, body?: Uint8Array, query?: Record<string, string> | undefined }} [options]
   * @returns {Promise<Response>}
   */
  async function send(method, path, options = {}) {
    const target = new URL(path, base);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      target.searchParams.set(key, value);
    }
    /** @type {Record<string, string>} */
    const headers = { ...auth, accept: "application/json" };
    /** @type {BodyInit | undefined} */
    let body;
    if (options.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.json);
    } else if (options.body !== undefined) {
      headers["content-type"] = "application/octet-stream";
      body = /** @type {BodyInit} */ (options.body);
    }
    let response;
    try {
      response = await fetchImpl(target.toString(), {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new AdminError(`request to ${target.pathname} failed: ${reason}`, 0, null, {});
    }
    if (response.status >= 300 && response.status < 400) {
      // Access redirects to its login page when the service token is missing or wrong.
      throw new AdminError(
        `${target.pathname}: redirected (${response.status}); check the Access service token`,
        response.status,
        "access-redirect",
        {},
      );
    }
    if (!response.ok) {
      /** @type {Record<string, unknown>} */
      let parsed = {};
      try {
        parsed = /** @type {Record<string, unknown>} */ (await response.json());
      } catch {
        // not JSON (e.g. an Access or platform error page)
      }
      const message = typeof parsed.error === "string" ? parsed.error : `HTTP ${response.status}`;
      const code = typeof parsed.code === "string" ? parsed.code : null;
      throw new AdminError(`${target.pathname}: ${message}`, response.status, code, parsed);
    }
    return response;
  }

  /**
   * @template {string} P
   * @param {string} method
   * @param {P} path
   * @param {{ json?: unknown, body?: Uint8Array, query?: Record<string, string> | undefined }} [options]
   * @returns {Promise<ResponseOf<P>>}
   */
  async function json(method, path, options) {
    const response = await send(method, path, options);
    return /** @type {ResponseOf<P>} */ (await response.json());
  }

  return {
    /**
     * The same client, authorized by the session credential of a token import instead of IMPORT_TOKEN.
     * @param {string} secret
     */
    withSession: (secret) =>
      createClient({
        url,
        fetch: fetchImpl,
        credentials: { ...credentials, importToken: undefined, importSession: secret },
      }),
    /** @template {string} P @param {P} path @param {Record<string, string>} [query] */
    get: (path, query) => json("GET", path, { query }),
    /** @template {string} P @param {P} path @param {unknown} [body] */
    post: (path, body = {}) => json("POST", path, { json: body }),
    /** @template {string} P @param {P} path @param {Uint8Array} bytes @param {Record<string, string>} query */
    postBytes: (path, bytes, query) => json("POST", path, { body: bytes, query }),
    /**
     * The dump step: a JSON line with the cursor, then the chunk bytes.
     * @param {DumpCursor} cursor
     * @param {number | undefined} maxBytes
     * @returns {Promise<{ meta: { cursor: DumpCursor }, chunk: Uint8Array }>}
     */
    async dumpNext(cursor, maxBytes) {
      const response = await send("POST", "/admin/dump/next", { json: { cursor, maxBytes } });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const newline = bytes.indexOf(0x0a);
      if (newline === -1) {
        throw new AdminError("/admin/dump/next: malformed response", response.status, null, {});
      }
      const meta = /** @type {{ cursor: DumpCursor }} */ (
        JSON.parse(new TextDecoder().decode(bytes.subarray(0, newline)))
      );
      return { meta, chunk: bytes.subarray(newline + 1) };
    },
  };
}

/** @typedef {ReturnType<typeof createClient>} AdminClient */
