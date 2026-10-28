import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  allocateLocalId,
  cryptoRandomInt,
  insertWithFreshId,
  type RandomInt,
  remoteId,
  requestedId,
  storedIdOf,
} from "../src/domain/ids";
import { writeOperation } from "../src/domain/operation";
import { BUILD, freshStore, migratedStore, testKernel } from "./helpers";

const NOW = Date.parse("2026-10-12T12:34:56.789Z");
const fixed =
  (value: number): RandomInt =>
  (max) =>
    Math.min(value, max - 1);

function timeOf(id: string): number {
  return Number(BigInt(id) >> 16n);
}

describe("ID generator", () => {
  it("draws crypto random integers only within the requested range", () => {
    for (const max of [1, 2, 1000, 0x10000]) {
      for (let i = 0; i < 2000; i++) {
        const value = cryptoRandomInt(max);
        expect(Number.isInteger(value) && value >= 0 && value < max).toBe(true);
      }
    }
  });

  it("produces 18-digit decimal remote IDs", () => {
    for (const id of [
      remoteId("2018-05-10T00:00:00Z", NOW),
      remoteId("2400-01-01T00:00:00Z", Date.parse("2400-01-01")),
    ]) {
      expect(id).toMatch(/^\d{18}$/);
    }
  });

  it("allocates local IDs in the Store that increase within one millisecond and across a backwards clock", async () => {
    const store = freshStore();
    await runInDurableObject(store, async (_instance, state) => {
      const k = testKernel(state);
      await k.upgrade();
      const allocate = writeOperation<{ now: number; random: RandomInt }, string>((db, { now, random }) =>
        allocateLocalId(db, now, random),
      );
      const ids = [
        await k.execute(BUILD, allocate, { now: NOW, random: fixed(0xffff) }),
        // Same millisecond, lower random bits.
        await k.execute(BUILD, allocate, { now: NOW, random: fixed(0) }),
        // The clock went back five seconds.
        await k.execute(BUILD, allocate, { now: NOW - 5000, random: fixed(0x8000) }),
      ];
      for (const id of ids) {
        expect(id).toMatch(/^\d{18}$/);
      }
      expect(timeOf(ids[0]!)).toBe(NOW);
      expect([...ids].toSorted()).toEqual(ids);
      expect(new Set(ids).size).toBe(3);

      // The allocation shares the transaction of the write: a failed write does not advance it.
      const failing = writeOperation<void, void>((db) => {
        allocateLocalId(db, NOW + 1000, fixed(0));
        throw new Error("write failed");
      });
      await expect(k.execute(BUILD, failing, undefined)).rejects.toThrow("write failed");
      expect(await k.execute(BUILD, allocate, { now: NOW - 5000, random: fixed(0) })).toBe(
        (BigInt(ids[2]!) + 1n).toString(),
      );
    });
  });

  it("truncates published to the second and adds 0-999 random ms for remote IDs", () => {
    expect(timeOf(remoteId("2026-10-12T12:00:00.987Z", NOW, fixed(0)))).toBe(Date.parse("2026-10-12T12:00:00.000Z"));
    expect(timeOf(remoteId("2026-10-12T12:00:00.987Z", NOW, fixed(999)))).toBe(Date.parse("2026-10-12T12:00:00.999Z"));
  });

  it("clamps future, unparsable, and too-early published times", () => {
    const nowSecond = Math.floor(NOW / 1000) * 1000;
    expect(timeOf(remoteId("2999-01-01T00:00:00Z", NOW, fixed(0)))).toBe(nowSecond);
    expect(timeOf(remoteId("not a date", NOW, fixed(0)))).toBe(nowSecond);
    expect(timeOf(remoteId("2001-01-01T00:00:00Z", NOW, fixed(0)))).toBe(Date.UTC(2018, 4, 10));
  });

  it("regenerates on an ID collision and lets other UNIQUE violations through", async () => {
    await runInDurableObject(await migratedStore(), (_instance, state) => {
      const sql = state.storage.sql;
      const insert = (uri: string) => (id: string) => {
        sql.exec("INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, 'a', 'x.test')", id, uri);
        return id;
      };
      const taken = remoteId("2026-10-12T00:00:00Z", NOW, fixed(1));
      insert("https://x.test/1")(taken);

      const candidates = [taken, remoteId("2026-10-12T00:00:00Z", NOW, fixed(2))];
      const id = state.storage.transactionSync(() =>
        insertWithFreshId("accounts", () => candidates.shift()!, insert("https://x.test/2")),
      );
      expect(id).toBe(remoteId("2026-10-12T00:00:00Z", NOW, fixed(2)));

      expect(() =>
        insertWithFreshId(
          "accounts",
          () => remoteId("2026-10-12T00:00:00Z", NOW, fixed(3)),
          insert("https://x.test/1"),
        ),
      ).toThrow("UNIQUE constraint failed: accounts.uri");
    });
  });
});

describe("requestedId", () => {
  // Each input with what Ruby's String#to_i gives for it (measured with Ruby; Mastodon's `.map(&:to_i)`).
  const RUBY: [string, string][] = [
    ["", "0"],
    ["abc", "0"],
    [" 12", "12"],
    ["\t\n\v\f\r 7", "7"],
    ["\u00a07", "0"],
    ["\u30007", "0"],
    ["\u00007", "0"],
    ["1_0", "10"],
    ["1_2_3", "123"],
    ["_1", "0"],
    ["1_", "1"],
    ["1__2", "1"],
    ["0_1", "1"],
    ["0__1", "0"],
    ["00_1", "1"],
    ["0_", "0"],
    ["0012", "12"],
    ["07", "7"],
    ["0d12", "12"],
    ["0D12", "12"],
    ["+0d12", "12"],
    ["-0d12", "-12"],
    [" +0d00_12", "12"],
    ["0d", "0"],
    ["0d_1", "0"],
    ["0d+1", "0"],
    ["0d0d1", "0"],
    ["0d1_2", "12"],
    ["0d1__2", "1"],
    ["0_d1", "0"],
    ["0x10", "0"],
    ["0b1", "0"],
    ["0o7", "0"],
    ["+5", "5"],
    ["-12", "-12"],
    ["- 5", "0"],
    ["+-1", "0"],
    ["-_1", "0"],
    ["-0", "0"],
    ["-00_0", "0"],
    ["-0d0", "0"],
    ["12abc", "12"],
    ["1 2", "1"],
    ["100000000000000001 ", "100000000000000001"],
    ["9007199254740993", "9007199254740993"],
    ["0d9007199254740993", "9007199254740993"],
    ["-99999999999999999999999", "-99999999999999999999999"],
  ];

  it.each(RUBY)("reads %j as Ruby does", (input, expected) => {
    expect(requestedId(input)).toBe(expected);
  });

  it("gives the stored form of a normalized id: 18 characters, padded with zeros", () => {
    expect(storedIdOf("123")).toBe("000000000000000123");
    expect(storedIdOf("0")).toBe("000000000000000000");
    expect(storedIdOf("117424993075228525")).toBe("117424993075228525");
    expect(storedIdOf("1".repeat(19))).toBe("1".repeat(19));
    expect(storedIdOf("-12")).toBe("-12");
  });

  it("is never longer than its input", () => {
    for (const [input] of RUBY) {
      expect(requestedId(input).length).toBeLessThanOrEqual(Math.max(input.length, 1));
    }
    const long = `${"0".repeat(100_000)}${"9".repeat(100_000)}x`;
    expect(requestedId(long)).toBe("9".repeat(100_000));
  });
});
