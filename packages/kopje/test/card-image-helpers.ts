import { runInDurableObject } from "cloudflare:test";

import { type CardImagesDeps, cardImagesRound } from "../src/federation/card-images";
import { type LinkCardsDeps, linkCardsRound } from "../src/federation/link-cards";
import { imagesCodec } from "../src/platform/images";
import type { StoreOperation } from "../src/platform/store-kernel";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { BUILD } from "./helpers";
import { localRgba } from "./images-binding";
import { community, post } from "./status-helpers";

// A community whose card rounds run over routed pages (federation/link-cards.ts), for the card image suites.

type Route = (request: Request) => Response | Promise<Response>;

const HTML = { "content-type": "text/html; charset=utf-8" };

// A page whose card names `image` (og:image) and its alt text.
export const pageWith =
  (image: string, alt = "") =>
  () =>
    new Response(
      `<html><head><title>Title</title><meta property="og:image" content="${image}"><meta property="og:image:alt" content="${alt}"></head></html>`,
      { headers: HTML },
    );

type CardRow = {
  status_id: string;
  image_url: string;
  image_id: string | null;
  image_description: string;
  fetched_at: number | null;
};

type ImageRow = {
  id: string;
  source_url: string;
  due_at: number | null;
  enqueued_at: number;
  claim: number;
  attempts: number;
  token: string | null;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  stored_at: number | null;
};

export async function cardWorld(overrides: Record<string, unknown> = {}) {
  const h = await community(["alice"], "read write follow", {}, overrides);
  const { alice } = h.users;
  const clock = { t: NOW };
  h.now.mockImplementation(() => clock.t);
  const requests: string[] = [];
  let routes: Record<string, Route> = {};
  const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(`${request.method} ${request.url}`);
    const route = routes[request.url];
    return Promise.resolve(route === undefined ? new Response("missing", { status: 404 }) : route(request));
  };
  const deps = (): LinkCardsDeps => ({
    build: () => BUILD,
    store: () => h.store,
    now: () => clock.t,
    keygen: () => Promise.reject(new Error("no keys")),
    loader: { fetch, checkHost: () => Promise.resolve() },
  });
  let tokens = 0;
  const imageDeps = (extra: Partial<CardImagesDeps> = {}): CardImagesDeps => ({
    ...deps(),
    images: () => imagesCodec(localRgba().binding),
    randomToken: () => `k${String(++tokens).padStart(42, "0")}`,
    ...extra,
  });
  const op = <I, O>(operation: StoreOperation<I, O>, input: I) =>
    runInDurableObject(h.store, (_instance, s) => operation.run(s.storage.sql, input));
  return {
    h,
    alice,
    clock,
    requests,
    fetch,
    op,
    addRoutes: (more: Record<string, Route>) => {
      routes = { ...routes, ...more };
    },
    cardRound: () => linkCardsRound(h.env as unknown as Env, deps()),
    imageDeps,
    imageRound: (extra: Partial<CardImagesDeps> = {}, env: Record<string, unknown> = {}) =>
      cardImagesRound({ ...h.env, ...env } as unknown as Env, imageDeps(extra)),
    postLink: async (url: string) => (await post(h, alice, { status: `see ${url}` })).id,
    card: async (id: string) =>
      (
        await sql<CardRow>(
          h.store,
          "SELECT status_id, image_url, image_id, image_description, fetched_at FROM status_cards WHERE status_id = ?",
          id,
        )
      )[0],
    images: () => sql<ImageRow>(h.store, "SELECT * FROM card_images ORDER BY id"),
    orphans: () =>
      sql<{ file_token: string; media_id: string; delete_after: string }>(
        h.store,
        "SELECT file_token, media_id, delete_after FROM media_orphans ORDER BY delete_after, file_token",
      ),
  };
}

export type CardWorld = Awaited<ReturnType<typeof cardWorld>>;
