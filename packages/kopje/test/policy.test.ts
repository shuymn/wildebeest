import { describe, expect, it } from "vitest";

import { MIGRATIONS } from "../src/db/migrations";
import { DISTRIBUTABLE_SQL, REACHES_FOLLOWERS_SQL, REQUIRES_MENTION_SQL } from "../src/domain/audience";

// The visibility sets of the policy module (docs/visibility.md), against the schema the feeds' index uses. The policy
// boundary in the sources is test-node/policy-boundary.test.ts.

describe("visibility sets", () => {
  it("are generated from isDistributable and requiresMention", () => {
    expect(DISTRIBUTABLE_SQL).toBe("('public', 'unlisted')");
    expect(REQUIRES_MENTION_SQL).toBe("('direct', 'limited')");
    expect(REACHES_FOLLOWERS_SQL).toBe("('public', 'unlisted', 'private')");
  });

  it("match the partial index the feeds use, which SQLite applies only to the same list", () => {
    const schema = MIGRATIONS.map((migration) => migration.sql).join("\n");
    expect(schema).toContain(
      `CREATE INDEX statuses_feed ON statuses (account_id, id) WHERE visibility IN ${REACHES_FOLLOWERS_SQL};`,
    );
  });
});
