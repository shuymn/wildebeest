import { expect, it, vi } from "vitest";

// Bounds computed at module load from another module's export are numbers in the order the Worker loads its modules.
// The module registry is reset first, since the suites share it (isolate: false) and an earlier one may have loaded
// these modules in another order; they are then imported dynamically, after the entry, so a sorted import list in this
// file cannot choose the order either. A module read before its cycle partner has initialized makes the bound NaN
// (remote-suspension.ts SEVER_ROWS, delivery-bounds.ts; announcements.ts reads custom-emojis.ts
// MAX_LOCAL_EMOJI_NAMES across the same cycle).
it("loads the moderation and announcement bounds as numbers after the Worker entry", async () => {
  vi.resetModules();
  await import("../src/worker");
  const { SEVER_ROWS } = await import("../src/domain/remote-suspension");
  const { ANNOUNCEMENT_ROW_CAPS } = await import("../src/domain/announcements");
  expect(Number.isInteger(SEVER_ROWS), `SEVER_ROWS is ${SEVER_ROWS}`).toBe(true);
  expect(Number.isInteger(ANNOUNCEMENT_ROW_CAPS.presentation), `${ANNOUNCEMENT_ROW_CAPS.presentation}`).toBe(true);
});
