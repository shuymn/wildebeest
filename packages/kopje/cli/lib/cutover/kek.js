/* global atob, crypto */
// Which KEK wraps each local user's private key. Keys are carried over wrapped, without re-wrapping (DATA-1), so the
// Store needs one USER_KEK that unwraps every key. The candidates are the empty string (legacy instances that never
// set one), and the values of the legacy secret names userKEK and USER_KEY when they are in the environment. Only
// candidate names are reported, never values or key material; users are named by a digest of their actor URI.

const PBKDF2_ITERATIONS = 10000;
const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const PROBE = new TextEncoder().encode("kopje cutover key check");

/**
 * @param {string} kek
 * @param {Uint8Array<ArrayBuffer>} privkey
 * @param {Uint8Array<ArrayBuffer>} salt
 * @param {string} pubkey
 */
async function unwraps(kek, privkey, salt, pubkey) {
  try {
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(kek), "PBKDF2", false, [
      "deriveKey",
    ]);
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const pkcs8 = await crypto.subtle.decrypt({ name: "AES-GCM", iv: salt }, key, privkey);
    const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, RSA, false, ["sign"]);
    const signature = await crypto.subtle.sign(RSA, privateKey, PROBE);
    const body = pubkey.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "");
    const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
    const publicKey = await crypto.subtle.importKey("spki", der, RSA, false, ["verify"]);
    return await crypto.subtle.verify(RSA, publicKey, signature, PROBE);
  } catch {
    return false;
  }
}

/** @param {string} text */
async function digest(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(bytes.subarray(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * @typedef {{ candidates: string[], users: { account: string, kek: string | null }[], uniform: boolean,
 *   kek: string | null, emptyKek: boolean }} KekReport
 */

/**
 * @param {{ uri: string, privkey: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, pubkey: string }[]} users
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<KekReport>}
 */
export async function checkKeks(users, env) {
  /** @type {[string, string][]} */
  const candidates = [["empty", ""]];
  for (const name of ["userKEK", "USER_KEY"]) {
    const value = env[name];
    if (typeof value === "string" && value !== "") {
      candidates.push([name, value]);
    }
  }
  const results = [];
  for (const user of users) {
    let found = null;
    for (const [name, value] of candidates) {
      if (await unwraps(value, user.privkey, user.salt, user.pubkey)) {
        found = name;
        break;
      }
    }
    results.push({ account: await digest(user.uri), kek: found });
  }
  const keks = new Set(results.map((r) => r.kek));
  const uniform = results.length > 0 && keks.size === 1 && !keks.has(null);
  const kek = uniform ? (results[0]?.kek ?? null) : null;
  return { candidates: candidates.map(([name]) => name), users: results, uniform, kek, emptyKek: kek === "empty" };
}
