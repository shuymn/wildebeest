import { env } from "cloudflare:workers";
import { beforeAll } from "vitest";

// Setup of every suite of the kopje project (vitest.config.ts). The suites run without isolation, so the media bucket
// of a worker outlives each suite it runs, and tests keep fixed keys within a suite (a fixture's ids and tokens, keys
// such as `files/WWW…`). Each suite starts on an empty bucket, as it did isolated; the Store needs nothing, since every
// test has one of its own name (test/helpers.ts).
beforeAll(async () => {
  let cursor: string | undefined;
  do {
    const listed = await env.MEDIA.list(cursor === undefined ? {} : { cursor });
    if (listed.objects.length > 0) {
      await env.MEDIA.delete(listed.objects.map((object) => object.key));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
});
