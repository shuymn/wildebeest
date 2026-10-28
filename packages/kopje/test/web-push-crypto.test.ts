import { base64url, importJWK, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";

import {
  encryptPush,
  MAX_PUSH_PLAINTEXT,
  openPushToken,
  type PushEncoding,
  sealPushToken,
  VAPID_TOKEN_SECONDS,
  vapidToken,
} from "../src/security/web-push";
import { decryptPush, newClient, VAPID } from "./push-helpers";

// Web Push encryption pinned to the published examples, and VAPID and token sealing (security/web-push.ts).

const P256 = { name: "ECDH", namedCurve: "P-256" } as const;

// The sender's key pair of an example, from its private scalar and public point.
async function senderKeys(privateKey: string, publicKey: string): Promise<CryptoKeyPair> {
  const point = base64url.decode(publicKey);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: base64url.encode(point.slice(1, 33)),
    y: base64url.encode(point.slice(33)),
  };
  return {
    privateKey: await crypto.subtle.importKey("jwk", { ...jwk, d: privateKey }, P256, false, ["deriveBits"]),
    publicKey: await crypto.subtle.importKey("raw", point, P256, true, []),
  };
}

describe("Web Push encryption", () => {
  it("matches RFC 8291 Appendix A (aes128gcm)", async () => {
    const encrypted = await encryptPush(
      new TextEncoder().encode("When I grow up, I want to be a watermelon"),
      {
        p256dh: base64url.decode(
          "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        ),
        auth: base64url.decode("BTBZMqHH6r4Tts7J_aSIgg"),
      },
      "aes128gcm",
      {
        senderKeys: await senderKeys(
          "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
          "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
        ),
        salt: base64url.decode("DGv6ra1nlYgDCS1FRnbzlw"),
      },
    );
    expect(base64url.encode(encrypted.body)).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
        "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
        "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("matches draft-ietf-webpush-encryption-04 Appendix A (aesgcm)", async () => {
    const sender = "BNoRDbb84JGm8g5Z5CFxurSqsXWJ11ItfXEWYVLE85Y7CYkDjXsIEc4aqxYaQ1G8BqkXCJ6DPpDrWtdWj_mugHU";
    const encrypted = await encryptPush(
      new TextEncoder().encode("I am the walrus"),
      {
        p256dh: base64url.decode(
          "BCEkBjzL8Z3C-oi2Q7oE5t2Np-p7osjGLg93qUP0wvqRT21EEWyf0cQDQcakQMqz4hQKYOQ3il2nNZct4HgAUQU",
        ),
        auth: base64url.decode("R29vIGdvbyBnJyBqb29iIQ"),
      },
      "aesgcm",
      {
        senderKeys: await senderKeys("nCScek-QpEjmOOlT-rQ38nZzvdPlqa00Zy0i6m2OJvY", sender),
        salt: base64url.decode("lngarbyKfMoi9Z75xYXmkg"),
      },
    );
    expect(base64url.encode(encrypted.body)).toBe("6nqAQUME8hNqw5J3kl8cpVVJylXKYqZOeseZG8UueKpA");
    expect(base64url.encode(encrypted.senderPublicKey)).toBe(sender);
    expect(base64url.encode(encrypted.salt)).toBe("lngarbyKfMoi9Z75xYXmkg");
  });

  it.each<PushEncoding>(["aes128gcm", "aesgcm"])("round-trips a fresh message in %s", async (encoding) => {
    const client = await newClient();
    const message = new TextEncoder().encode('{"title":"héllo"}');
    const first = await encryptPush(message, client.keys, encoding);
    const second = await encryptPush(message, client.keys, encoding);
    expect(new TextDecoder().decode(await decryptPush(client, encoding, first))).toBe('{"title":"héllo"}');
    // A fresh key and salt every time.
    expect(base64url.encode(second.body)).not.toBe(base64url.encode(first.body));
    expect(base64url.encode(second.salt)).not.toBe(base64url.encode(first.salt));
  });

  it("fits the largest payload in 4096 octets and refuses a larger one", async () => {
    const client = await newClient();
    const largest = await encryptPush(new Uint8Array(MAX_PUSH_PLAINTEXT), client.keys, "aes128gcm");
    expect(largest.body.length).toBe(4096);
    await expect(encryptPush(new Uint8Array(MAX_PUSH_PLAINTEXT + 1), client.keys, "aesgcm")).rejects.toThrow(
      "push payload too large",
    );
  });
});

describe("VAPID (RFC 8292) and the sealed token", () => {
  it("signs an ES256 token for the push service origin that expires within 24 hours", async () => {
    const now = Date.UTC(2026, 9, 15);
    const token = await vapidToken(VAPID.jwk, "https://push.example", "https://kopje.test/", now);
    const { x, y } = VAPID.jwk;
    const { payload, protectedHeader } = await jwtVerify(
      token,
      await importJWK({ kty: "EC", crv: "P-256", x, y }, "ES256"),
      { currentDate: new Date(now), audience: "https://push.example" },
    );
    expect(protectedHeader).toEqual({ typ: "JWT", alg: "ES256" });
    expect(payload).toEqual({
      aud: "https://push.example",
      sub: "https://kopje.test/",
      exp: now / 1000 + VAPID_TOKEN_SECONDS,
    });
    expect(VAPID_TOKEN_SECONDS).toBeLessThanOrEqual(24 * 60 * 60);
  });

  it("opens a sealed token only with its key and digest (AUTH-7)", async () => {
    const sealed = await sealPushToken(VAPID.jwk, "digest-a", "the-token");
    expect(sealed).not.toContain("the-token");
    expect(await openPushToken(VAPID.jwk, "digest-a", sealed)).toBe("the-token");
    expect(await openPushToken(VAPID.jwk, "digest-b", sealed)).toBeNull();
    const other = (await crypto.subtle.exportKey(
      "jwk",
      ((await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair)
        .privateKey,
    )) as JsonWebKey;
    expect(await openPushToken(other, "digest-a", sealed)).toBeNull();
  });
});
