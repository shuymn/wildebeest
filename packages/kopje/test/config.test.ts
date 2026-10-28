import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { readConfig } from "../src/platform/config";

describe("readConfig", () => {
  // The admin health report and the kopje.config.invalid log show these issues.
  it("names each invalid variable and its problem, never its value", () => {
    const { STORE: _store, ...withoutStore } = env;
    const config = readConfig({
      ...withoutStore,
      MAINTENANCE: "value-7f3a",
      SETUP_TOKEN: "",
      // A secret set as a JSON binding of another type.
      USER_KEK: 123456789,
      USER_KEK_PREVIOUS: { secret: "value-7f3a" },
      IMAGES_MONTHLY_TRANSFORMS: "4321.5",
      // An object Number() cannot convert: it throws, which is the same type issue.
      IMAGES_ACCOUNT_MONTHLY_TRANSFORMS: { toString: null },
      IMAGES_CARD_MONTHLY_TRANSFORMS: "value-7f3a",
      REMOTE_MEDIA_CACHE_BYTES: "-4321",
      MEDIA_CACHE_RETENTION_DAYS: "98765",
      CUTOVER_ROLLBACK: "value-7f3a",
      CUTOVER_JOURNAL_MAX_ENTRIES: "0",
      VAPID_JWK: "value-7f3a",
    });
    expect(config).toEqual({
      ok: false,
      issues: [
        "STORE: binding STORE is missing",
        'MAINTENANCE: Invalid option: expected one of "off"|"readonly"|"full"',
        "SETUP_TOKEN: Too small: expected string to have >=1 characters",
        "USER_KEK: Invalid input: expected string, received number",
        "USER_KEK_PREVIOUS: Invalid input: expected string, received object",
        "IMAGES_MONTHLY_TRANSFORMS: Invalid input: expected int, received number",
        "IMAGES_ACCOUNT_MONTHLY_TRANSFORMS: Invalid input: expected number, received object",
        "IMAGES_CARD_MONTHLY_TRANSFORMS: Invalid input: expected number, received NaN",
        "REMOTE_MEDIA_CACHE_BYTES: Too small: expected number to be >=0",
        "REMOTE_MEDIA_CACHE_BYTES: must be 0 or at least 268435456",
        "MEDIA_CACHE_RETENTION_DAYS: Too big: expected number to be <=36500",
        'CUTOVER_ROLLBACK: Invalid input: expected "journal"',
        "CUTOVER_JOURNAL_MAX_ENTRIES: Too small: expected number to be >=1",
        "VAPID_JWK: must be an EC P-256 private key JWK",
      ],
    });
  });
});
