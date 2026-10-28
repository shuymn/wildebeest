import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { adminRefusal, settingsFromRows } from "../src/platform/access-settings";
import { sameLoginEmail, sqliteLower } from "../src/platform/login-email";
import { ASCII_EMAIL_VARIANT, FOLDED_EMAIL, freshStore, UNICODE_EMAIL_VARIANTS } from "./helpers";

// AUTH-9: the sign-in's email rule in code (platform/login-email.ts) is SQLite's lower() as the Store runs it.

const SAMPLES = [
  "Kim@Example.COM",
  "Kim",
  "STRAẞE",
  "straße",
  "İRIS",
  "i̇ris",
  "Äpfel",
  "äpfel",
  // Every printable ASCII character.
  String.fromCharCode(...Array.from({ length: 95 }, (_, i) => 32 + i)),
  FOLDED_EMAIL,
  ASCII_EMAIL_VARIANT,
  ...UNICODE_EMAIL_VARIANTS,
];

describe("the sign-in’s email rule in code (AUTH-9)", () => {
  it("is SQLite’s lower(), run on ASCII and non-ASCII samples", async () => {
    const result = await runInDurableObject(freshStore(), (_instance, state) => {
      const sql = state.storage.sql;
      return {
        lower: SAMPLES.map((text) => ({
          sqlite: sql.exec<{ v: string }>("SELECT lower(?) AS v", text).one().v,
          code: sqliteLower(text),
        })),
        same: SAMPLES.flatMap((a) =>
          SAMPLES.map((b) => ({
            a,
            b,
            sqlite: sql.exec<{ v: number }>("SELECT lower(?1) = lower(?2) AS v", a, b).one().v === 1,
            code: sameLoginEmail(a, b),
          })),
        ),
      };
    });
    for (const { sqlite, code } of result.lower) {
      expect(code).toBe(sqlite);
    }
    for (const { a, b, sqlite, code } of result.same) {
      expect(code, `${a} / ${b}`).toBe(sqlite);
    }
    // The samples reach both outcomes: an ASCII variant is the same email, a Unicode one another.
    expect(result.same.some(({ a, b, code }) => a !== b && code)).toBe(true);
    expect(sameLoginEmail(ASCII_EMAIL_VARIANT, FOLDED_EMAIL)).toBe(true);
    expect(sameLoginEmail("Kim", "kim")).toBe(false);
  });

  it("decides who the Access admin is: ASCII case only, with no trim", () => {
    const settings = (adminEmail: string) => settingsFromRows([{ name: "admin_email", value: adminEmail }]);
    const identity = (email: string) => ({ email, commonName: null });
    expect(adminRefusal(settings(FOLDED_EMAIL), identity(ASCII_EMAIL_VARIANT))).toBeNull();
    for (const email of UNICODE_EMAIL_VARIANTS) {
      expect(adminRefusal(settings(FOLDED_EMAIL), identity(email)), email).toBe("this identity is not the admin");
    }
    // A stored admin_email with surrounding whitespace is kept, and is another email than its trimmed form.
    expect(settings(` ${FOLDED_EMAIL}`).adminEmail).toBe(` ${FOLDED_EMAIL}`);
    expect(adminRefusal(settings(` ${FOLDED_EMAIL}`), identity(FOLDED_EMAIL))).toBe("this identity is not the admin");
    // A blank one is unset.
    expect(settings("  ").adminEmail).toBeNull();
    expect(adminRefusal(settings("  "), identity(FOLDED_EMAIL))).toBe("this identity is not the admin");
  });
});
