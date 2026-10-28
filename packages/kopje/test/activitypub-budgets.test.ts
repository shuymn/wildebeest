import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { getOutbox, OUTBOX_BYTES, type OutboxPage } from "../src/domain/activities";
import { utf8Length } from "../src/platform/dump-format";
import { NOW } from "./app-helpers";
import { bigStatus } from "./budget-helpers";
import { community } from "./status-helpers";

// RES-3: an outbox page's activities are within OUTBOX_BYTES, admitted newest first, the page cut there continuing
// from its last activity (docs/response-inventory.md, "ActivityPub").

describe("outbox pages within their byte bound (RES-3)", () => {
  it("page every status once, each page cut by bytes continuing from its last activity", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      ids.push(await bigStatus(h, alice.id, NOW - (20 - i) * 60_000));
    }
    const seen: string[] = [];
    const pages: string[][] = [];
    for (let before: string | null = "999999999999999999"; before !== null;) {
      const page: OutboxPage = await runInDurableObject(h.store, (_instance, state) => {
        let output = getOutbox.run(state.storage.sql, { username: "alice", before: before! } as never) as Record<
          string,
          unknown
        >;
        while (output.status === "ok" && "value" in output) {
          output = output.value as Record<string, unknown>;
        }
        return output as OutboxPage;
      });
      const objects = page.items.map((item) => {
        const id = (JSON.parse(item) as { object: { id: string } }).object.id;
        return id.slice(id.lastIndexOf("/") + 1);
      });
      expect(page.items.reduce((sum, item) => sum + utf8Length(item) + 1, 0)).toBeLessThanOrEqual(OUTBOX_BYTES);
      if (page.next !== null) {
        expect(page.next).toBe(objects.at(-1));
      }
      seen.push(...objects);
      pages.push(objects);
      before = page.next;
      expect(pages.length).toBeLessThan(10);
    }
    expect(seen).toEqual(ids.toReversed());
    expect(pages[0]!.length).toBeLessThan(20);
  }, 300_000);
});
