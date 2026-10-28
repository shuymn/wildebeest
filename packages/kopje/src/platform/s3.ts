import { AwsClient } from "aws4fetch";

import { toHex } from "./backup-crypto";

// The few S3 calls the scheduled backup makes, path-style (https://endpoint/bucket/key) and signed with SigV4 by
// aws4fetch. Every request carries the SHA-256 of its payload, so the store rejects a body changed in transit.
//
// Every request, its retries included, ends by the caller's budget (the time left in the invocation), so the job keeps
// time to checkpoint. Errors are S3Error with the operation and HTTP status (or 'timeout') only. Neither the response body nor the request (which carries
// the signature) is kept, so an error can be logged and shown in health as is (DATA-5, DATA-9).

export type S3Settings = {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export type S3Fetch = (request: Request) => Promise<Response>;

export class S3Error extends Error {
  constructor(
    readonly op: string,
    readonly status: number | "timeout",
    options?: ErrorOptions,
  ) {
    super(`s3-${op}-${status}`, options);
    this.name = "S3Error";
  }
}

export type S3Object = { key: string; size: number };

const TIMEOUT_MS = 120_000;
// Idempotent requests are retried on 5xx, 429 and network failures; a POST (create, complete) is not.
const RETRIES = 2;

export class S3Client {
  readonly #aws: AwsClient;
  readonly #base: string;
  readonly #fetch: S3Fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #budget: () => number;

  constructor(
    settings: S3Settings,
    fetch: S3Fetch,
    {
      sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
      budget = () => TIMEOUT_MS,
    }: { sleep?: (ms: number) => Promise<void>; budget?: () => number } = {},
  ) {
    this.#aws = new AwsClient({
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
      service: "s3",
      region: settings.region,
      retries: 0,
    });
    this.#base = `${settings.endpoint}/${encodeURIComponent(settings.bucket)}`;
    this.#fetch = fetch;
    this.#sleep = sleep;
    this.#budget = budget;
  }

  async createMultipart(key: string, contentType: string): Promise<string> {
    const response = await this.#send("create-upload", "POST", key, { uploads: "" }, undefined, {
      "content-type": contentType,
    });
    const uploadId = elements(await body("create-upload", response.text()), "UploadId")[0];
    if (uploadId === undefined || uploadId === "") {
      throw new S3Error("create-upload", 0);
    }
    return uploadId;
  }

  async uploadPart(key: string, uploadId: string, partNumber: number, body: Uint8Array): Promise<string> {
    const response = await this.#send("upload-part", "PUT", key, { partNumber: String(partNumber), uploadId }, body);
    await response.body?.cancel();
    const etag = response.headers.get("etag");
    if (etag === null || etag === "") {
      throw new S3Error("upload-part", 0);
    }
    return etag;
  }

  async completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void> {
    const xml =
      "<CompleteMultipartUpload>" +
      parts
        .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`)
        .join("") +
      "</CompleteMultipartUpload>";
    const response = await this.#send("complete-upload", "POST", key, { uploadId }, new TextEncoder().encode(xml), {
      "content-type": "application/xml",
    });
    // S3 can answer 200 and report the failure in the body.
    if (/<Error>/.test(await body("complete-upload", response.text()))) {
      throw new S3Error("complete-upload", 200);
    }
  }

  // An upload that is already gone counts as aborted.
  async abortMultipart(key: string, uploadId: string): Promise<void> {
    const response = await this.#send("abort-upload", "DELETE", key, { uploadId }, undefined, {}, [404]);
    await response.body?.cancel();
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    const response = await this.#send("put", "PUT", key, {}, body, { "content-type": contentType });
    await response.body?.cancel();
  }

  async get(key: string): Promise<Uint8Array | null> {
    const response = await this.#send("get", "GET", key, {}, undefined, {}, [404]);
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    return new Uint8Array(await body("get", response.arrayBuffer()));
  }

  async delete(key: string): Promise<void> {
    const response = await this.#send("delete", "DELETE", key, {}, undefined, {}, [404]);
    await response.body?.cancel();
  }

  // Every key under the prefix (ListObjectsV2, all pages).
  async list(prefix: string): Promise<S3Object[]> {
    const objects: S3Object[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { "list-type": "2", prefix };
      if (token !== undefined) {
        query["continuation-token"] = token;
      }
      const xml = await body("list", (await this.#send("list", "GET", null, query)).text());
      for (const block of elements(xml, "Contents")) {
        const key = elements(block, "Key")[0];
        const size = Number(elements(block, "Size")[0] ?? "NaN");
        if (key !== undefined && key.startsWith(prefix) && Number.isSafeInteger(size)) {
          objects.push({ key, size });
        }
      }
      const truncated = elements(xml, "IsTruncated")[0] === "true";
      token = truncated ? elements(xml, "NextContinuationToken")[0] : undefined;
      if (truncated && (token === undefined || token === "")) {
        throw new S3Error("list", 0);
      }
    } while (token !== undefined);
    return objects;
  }

  // Multipart uploads in progress under the prefix (ListMultipartUploads, all pages).
  async listUploads(prefix: string): Promise<{ key: string; uploadId: string }[]> {
    const uploads: { key: string; uploadId: string }[] = [];
    let marker: { key: string; uploadId: string } | undefined;
    do {
      const query: Record<string, string> = { uploads: "", prefix };
      if (marker !== undefined) {
        query["key-marker"] = marker.key;
        query["upload-id-marker"] = marker.uploadId;
      }
      const xml = await body("list-uploads", (await this.#send("list-uploads", "GET", null, query)).text());
      for (const block of elements(xml, "Upload")) {
        const key = elements(block, "Key")[0];
        const uploadId = elements(block, "UploadId")[0];
        if (key !== undefined && key.startsWith(prefix) && uploadId !== undefined && uploadId !== "") {
          uploads.push({ key, uploadId });
        }
      }
      const truncated = elements(xml, "IsTruncated")[0] === "true";
      const nextKey = elements(xml, "NextKeyMarker")[0];
      const nextId = elements(xml, "NextUploadIdMarker")[0];
      marker =
        truncated && nextKey !== undefined && nextId !== undefined ? { key: nextKey, uploadId: nextId } : undefined;
      if (truncated && marker === undefined) {
        throw new S3Error("list-uploads", 0);
      }
    } while (marker !== undefined);
    return uploads;
  }

  async #send(
    op: string,
    method: string,
    key: string | null,
    query: Record<string, string>,
    body?: Uint8Array,
    headers: Record<string, string> = {},
    accept: number[] = [],
  ): Promise<Response> {
    const url = new URL(
      key === null ? this.#base : `${this.#base}/${key.split("/").map(encodeURIComponent).join("/")}`,
    );
    for (const [name, value] of Object.entries(query)) {
      url.searchParams.set(name, value);
    }
    const payloadHash = toHex(await crypto.subtle.digest("SHA-256", body ?? new Uint8Array(0)));
    for (let attempt = 0; ; attempt++) {
      const left = this.#budget();
      if (left <= 0) {
        throw new S3Error(op, "timeout");
      }
      let response: Response | null = null;
      try {
        const request = await this.#aws.sign(url.toString(), {
          method,
          headers: { ...headers, "x-amz-content-sha256": payloadHash },
          body: body ?? null,
          signal: AbortSignal.timeout(Math.min(TIMEOUT_MS, left)),
        });
        response = await this.#fetch(request);
      } catch (error) {
        const expired = timedOut(error);
        if (method === "POST" || attempt >= RETRIES || expired) {
          throw new S3Error(op, expired ? "timeout" : 0, { cause: error });
        }
      }
      if (response !== null) {
        if (response.ok || accept.includes(response.status)) {
          return response;
        }
        await response.body?.cancel();
        const retryable = response.status >= 500 || response.status === 429;
        if (method === "POST" || !retryable || attempt >= RETRIES) {
          throw new S3Error(op, response.status);
        }
      }
      const delay = 200 * 4 ** attempt;
      if (this.#budget() <= delay) {
        throw new S3Error(op, "timeout");
      }
      await this.#sleep(delay);
    }
  }
}

function timedOut(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

// A response body, read under the request's signal: a body that stalls past the time left fails like the request.
async function body<T>(op: string, read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (error) {
    throw new S3Error(op, timedOut(error) ? "timeout" : 0, { cause: error });
  }
}

// The text of each <name>...</name> element, entities decoded. S3 responses are flat enough for this: the names read
// here never nest inside themselves.
function elements(xml: string, name: string): string[] {
  const found: string[] = [];
  const pattern = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g");
  for (const match of xml.matchAll(pattern)) {
    found.push(unescapeXml(match[1] ?? ""));
  }
  return found;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/g, (whole, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1] === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[entity] ?? whole;
  });
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}
