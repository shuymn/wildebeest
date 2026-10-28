import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";

import { maintenanceWorker } from "../cli/lib/cutover/maintenance.js";
import { buildMaintenance } from "../scripts/build-maintenance.mjs";
import { writeExport } from "./cutover-helpers.js";
import { buildLegacyFixture } from "./legacy-fixture.js";

// The generated `_worker.js` runs on the legacy Pages project's own settings: the compatibility date legacy
// deployments use (2023-01-09) and no compatibility flag. Here it runs in workerd on exactly those settings, with a
// real Queue between it and a collecting consumer, so the spool message crosses the Queue's serialization as in
// production, from a streamed request body.

const LEGACY_COMPATIBILITY_DATE = "2023-01-09";
const SIGNATURE =
  'keyId="https://remote.example/users/a#main-key",headers="(request-target) host date digest",signature="x"';

let dir = "";
type Harness = ReturnType<typeof createTestHarness>;
let server: Harness;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "kopje-legacy-runtime-"));
  const bundleDir = join(dir, "bundle");
  buildMaintenance(bundleDir);
  const fixture = await buildLegacyFixture({ level: 39 });
  const exportPath = await writeExport(dir, fixture.texts);
  const pages = join(dir, "pages");
  const generated = await maintenanceWorker({ exportPath, domain: "kopje.test", outDir: pages, env: {}, bundleDir });
  expect(generated.ok).toBe(true);
  await writeFile(
    join(pages, "wrangler.jsonc"),
    JSON.stringify({
      name: "legacy-pages",
      main: "_worker.js",
      compatibility_date: LEGACY_COMPATIBILITY_DATE,
      no_bundle: true,
      queues: { producers: [{ binding: "KOPJE_QUEUE", queue: "kopje-spool" }] },
    }),
  );
  // The consumer logs what arrives, as the bytes of the deflated body and the rest of the message.
  const collector = join(dir, "collector");
  await mkdir(collector);
  await writeFile(
    join(collector, "index.js"),
    `export default {
	async queue(batch) {
		for (const message of batch.messages) {
			const { body, ...rest } = message.body
			console.log(JSON.stringify({ collected: { ...rest, body: Array.from(body) } }))
			message.ack()
		}
	},
}
`,
  );
  await writeFile(
    join(collector, "wrangler.jsonc"),
    JSON.stringify({
      name: "collector",
      main: "index.js",
      compatibility_date: LEGACY_COMPATIBILITY_DATE,
      queues: { consumers: [{ queue: "kopje-spool", max_batch_timeout: 1 }] },
    }),
  );
  server = createTestHarness({
    root: dir,
    workers: [{ configPath: join(pages, "wrangler.jsonc") }, { configPath: join(collector, "wrangler.jsonc") }],
  });
  await server.listen();
}, 120_000);

afterAll(async () => {
  await server?.close();
  await rm(dir, { recursive: true, force: true });
});

async function collected(count: number): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const messages = server
      .getLogs()
      .map((log) => (log as { message?: unknown }).message)
      .filter((message): message is string => typeof message === "string" && message.startsWith('{"collected"'))
      .map((message) => (JSON.parse(message) as { collected: Record<string, unknown> }).collected);
    if (messages.length >= count || Date.now() > deadline) {
      return messages;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function inflate(bytes: number[]): Promise<string> {
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Response(stream).text();
}

describe("the maintenance worker on the legacy runtime settings", () => {
  it("serves the snapshot and spools a streamed inbox POST through a real Queue", async () => {
    const actor = await server.fetch("https://kopje.test/ap/users/alice", {
      headers: { accept: "application/activity+json" },
    });
    expect(actor.status).toBe(200);
    expect(((await actor.json()) as { id: string }).id).toBe("https://kopje.test/ap/users/alice");
    expect((await server.fetch("https://kopje.test/api/v1/timelines/public")).status).toBe(503);

    const activity = JSON.stringify({
      type: "Follow",
      actor: "https://remote.example/users/a",
      padding: "x".repeat(70_000),
    });
    const encoded = new TextEncoder().encode(activity);
    // A body that arrives in pieces, as a peer's request does.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < encoded.length; i += 4096) {
          controller.enqueue(encoded.subarray(i, i + 4096));
        }
        controller.close();
      },
    });
    const response = await server.fetch("https://kopje.test/ap/users/alice/inbox", {
      method: "POST",
      headers: { "content-type": "application/activity+json", signature: SIGNATURE },
      body,
      duplex: "half",
    } as unknown as Parameters<Harness["fetch"]>[1]);
    expect(response.status).toBe(202);

    const [message] = await collected(1);
    expect(message).toMatchObject({ kind: "spool", method: "POST" });
    expect(new URL(message!.url as string).pathname).toBe("/ap/users/alice/inbox");
    expect(message!.headers).toContainEqual(["signature", SIGNATURE]);
    expect(typeof message!.spooledAt).toBe("number");
    expect(await inflate(message!.body as number[])).toBe(activity);
  });

  // (An oversized body is refused before it is read, so the local proxy in front of workerd fails the upload: that
  // case is tested in workerd directly, test/maintenance-worker.test.ts.)
  it("refuses a request without a signature on these settings too", async () => {
    const unsigned = await server.fetch("https://kopje.test/inbox", {
      method: "POST",
      headers: { "content-type": "application/activity+json" },
      body: "{}",
    });
    expect(unsigned.status).toBe(401);
  });
});
