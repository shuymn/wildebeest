import { base64url } from "jose";

// The VAPID_JWK secret: an EC P-256 private key as a JWK, which Kopje only reads (DATA-2). Each reader returns null
// for anything that is not an EC P-256 JWK with 32-byte coordinates and a 32-byte private scalar.

// The VAPID application server key that clients subscribe Web Push with: the uncompressed P-256 point
// (0x04 || x || y), base64url without padding.
export function vapidPublicKey(jwkText: string): string | null {
  const jwk = vapidJwk(jwkText);
  if (jwk === null) {
    return null;
  }
  const point = new Uint8Array(65);
  point[0] = 0x04;
  point.set(jwk.xBytes, 1);
  point.set(jwk.yBytes, 33);
  return base64url.encode(point);
}

// The key for signing VAPID tokens and sealing push tokens (security/web-push.ts).
export function vapidPrivateJwk(jwkText: string): JsonWebKey | null {
  const jwk = vapidJwk(jwkText);
  return jwk === null ? null : { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d };
}

function vapidJwk(jwkText: string): { x: string; y: string; d: string; xBytes: Uint8Array; yBytes: Uint8Array } | null {
  let jwk: unknown;
  try {
    jwk = JSON.parse(jwkText);
  } catch {
    return null;
  }
  if (typeof jwk !== "object" || jwk === null) {
    return null;
  }
  const { kty, crv, x, y, d } = jwk as Record<string, unknown>;
  if (kty !== "EC" || crv !== "P-256" || typeof x !== "string" || typeof y !== "string" || typeof d !== "string") {
    return null;
  }
  const xBytes = fromBase64Url(x);
  const yBytes = fromBase64Url(y);
  if (xBytes?.length !== 32 || yBytes?.length !== 32 || fromBase64Url(d)?.length !== 32) {
    return null;
  }
  return { x, y, d, xBytes, yBytes };
}

function fromBase64Url(text: string): Uint8Array | null {
  try {
    return base64url.decode(text);
  } catch {
    return null;
  }
}
