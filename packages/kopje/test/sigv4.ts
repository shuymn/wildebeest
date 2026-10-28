// An independent AWS Signature Version 4 calculation for S3 (header authorization), written from AWS's
// specification for the tests: the S3 mock verifies every request with it, and test/backup.test.ts checks it (and
// aws4fetch) against AWS's published examples.

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data));
}

// RFC 3986 encoding: everything but unreserved characters.
function encode(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export type SignedRequest = {
  method: string;
  url: string;
  headers: Headers;
  secretAccessKey: string;
  region: string;
};

export type ParsedAuthorization = {
  accessKeyId: string;
  date: string;
  region: string;
  signedHeaders: string[];
  signature: string;
};

export function parseAuthorization(value: string): ParsedAuthorization | null {
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, ?SignedHeaders=([a-z0-9;-]+), ?Signature=([0-9a-f]{64})$/.exec(
      value,
    );
  if (match === null) {
    return null;
  }
  const [, accessKeyId = "", date = "", region = "", signed = "", signature = ""] = match;
  return { accessKeyId, date, region, signedHeaders: signed.split(";"), signature };
}

// The signature of a request over the given signed headers, from x-amz-date and x-amz-content-sha256.
export async function signatureOf(request: SignedRequest, signedHeaders: string[]): Promise<string> {
  const url = new URL(request.url);
  const amzDate = request.headers.get("x-amz-date") ?? "";
  const path = url.pathname
    .split("/")
    .map((segment) => encode(decodeURIComponent(segment)))
    .join("/");
  const query = url.search
    .slice(1)
    .split("&")
    .filter((pair) => pair !== "")
    .map((pair) => {
      const at = pair.indexOf("=");
      const [k, v] = at < 0 ? [pair, ""] : [pair.slice(0, at), pair.slice(at + 1)];
      return [encode(decodeURIComponent(k)), encode(decodeURIComponent(v))] as const;
    })
    .toSorted(([k1, v1], [k2, v2]) => (k1 < k2 ? -1 : k1 > k2 ? 1 : v1 < v2 ? -1 : v1 > v2 ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const headerValue = (name: string) =>
    (name === "host" ? url.host : (request.headers.get(name) ?? "")).trim().replace(/\s+/g, " ");
  const canonical = [
    request.method,
    path,
    query,
    signedHeaders.map((name) => `${name}:${headerValue(name)}\n`).join(""),
    signedHeaders.join(";"),
    request.headers.get("x-amz-content-sha256") ?? "",
  ].join("\n");
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${request.region}/s3/aws4_request`;
  const toSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))),
  ].join("\n");
  let key = await hmac(new TextEncoder().encode(`AWS4${request.secretAccessKey}`), date);
  for (const part of [request.region, "s3", "aws4_request"]) {
    key = await hmac(key, part);
  }
  return hex(await hmac(key, toSign));
}
