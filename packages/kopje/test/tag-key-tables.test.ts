import { describe, expect, it } from "vitest";

import { MIGRATIONS } from "../src/db/migrations";
import { normalizeOnce } from "../src/domain/tag-name";
import { deriveTagKeyTables, tagKeyLiterals, tagKeyRows } from "./tag-key-tables";

// The proof that normalizeTag is a fixed point rests only on the tables test-node/tag-key-fixed-points.test.ts derives
// on Node and compares with the literals of 0087_tag_key_fixed_points. workerd derives its own: equal to the same
// literals, so the proof holds for the Store's runtime too, and the migration composes as normalizeTag does there.
describe("the Unicode tables of hashtag keys in workerd", () => {
  it("are the literals of 0087_tag_key_fixed_points", () => {
    const migration = MIGRATIONS.find((m) => m.name === "0087_tag_key_fixed_points")!;
    expect(migration.sql).toContain(`\n\n${tagKeyLiterals(tagKeyRows(deriveTagKeyTables(normalizeOnce)))}\n`);
  }, 60_000);
});
