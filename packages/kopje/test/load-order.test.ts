import { expect, it, vi } from "vitest";

// Bounds computed at module load from another module's export are numbers in the order the Worker loads its modules.
// The module registry is reset first, since the suites share it (isolate: false) and an earlier one may have loaded
// these modules in another order; they are then imported dynamically, after the entry, so a sorted import list in this
// file cannot choose the order either. A module read before its cycle partner has initialized would make the bound NaN
// (remote-suspension.ts SEVER_ROWS reads delivery-bounds.ts; announcements.ts reads custom-emojis.ts
// MAX_LOCAL_EMOJI_NAMES); import/no-cycle (.oxlintrc.json) refuses every value import cycle, and this checks the
// order at run time.
it("loads the moderation and announcement bounds as numbers after the Worker entry", async () => {
  vi.resetModules();
  await import("../src/worker");
  const { SEVER_ROWS } = await import("../src/domain/remote-suspension");
  const { ANNOUNCEMENT_ROW_CAPS } = await import("../src/domain/announcements");
  expect(Number.isInteger(SEVER_ROWS), `SEVER_ROWS is ${SEVER_ROWS}`).toBe(true);
  expect(Number.isInteger(ANNOUNCEMENT_ROW_CAPS.presentation), `${ANNOUNCEMENT_ROW_CAPS.presentation}`).toBe(true);
});

// status-presenter.ts (STATUS_LINK_COLUMNS) and trends.ts (TREND_CARD_COLUMNS, COPY_CHOICE_COLUMNS) build SQL at load
// from status-rows.ts's maps. Entered first, status-rows.ts loads its imports before itself; were one of them to lead
// back to status-presenter.ts, that module would read the maps before they exist and fail to load.
it("loads the status presenter and trends when status-rows.ts is loaded first", async () => {
  vi.resetModules();
  const { STATUS_COLUMN_MAP } = await import("../src/domain/status-rows");
  const { presentation } = await import("../src/domain/status-presenter");
  const { TREND_TAGS_LIMIT } = await import("../src/domain/trends");
  expect(STATUS_COLUMN_MAP.id).toBe("s.id");
  expect(typeof presentation).toBe("function");
  expect(TREND_TAGS_LIMIT).toBe(10);
});
