import { PUBLISH_ROUND } from "../domain/scheduled-statuses";
import { type CardImagesDeps, cardImagesRound } from "../federation/card-images";
import { ringDoorbell } from "../federation/delivery";
import { type FieldLinksDeps, fieldLinksRound } from "../federation/field-links";
import { type LinkCardsDeps, linkCardsRound } from "../federation/link-cards";
import { type RemoteMediaDeps, remoteMediaRound } from "../federation/remote-media";
import { reconcileMedia, sweepMedia, type SweepDeps } from "../mastodon/media";
import { readConfig } from "../platform/config";
import { DeadlinePassed } from "../platform/deadline";
import { errorFields } from "../platform/error-message";
import { callStore } from "../platform/store-client";
import { StoreUnavailableError } from "../platform/store-errors";

// The 5-minute cron (wrangler.jsonc). Nothing runs while the env sets maintenance (or is invalid), as for the queue; in
// the Store's own maintenance its writes are refused and each task waits for the next run.
//   - media: deletes one batch of doomed uploads and their R2 objects (domain/media.ts), then the R2 keys of one batch
//     of tombstones that fell due. Both are refused by the Store in maintenance, a dump or an import, and do nothing
//     in a Store that is not set up.
//   - /setup: records that the cron ran.
//   - scheduled statuses: publishes up to PUBLISH_ROUND that are due, each in its own transaction that deletes it, then
//     rings the delivery doorbell for what they record (domain/scheduled-statuses.ts). In the Store's maintenance or
//     readonly state nothing is published and what is due waits for the next run.
//   - announcements: one round (domain/announcements.ts announcementRound): publishes the scheduled ones that are due
//     and takes down the published ones that ended, at most the live cap of each. In the Store's maintenance or
//     readonly state, they wait.
//   - trends: one round (domain/trends.ts trendsRound): the hashtags and statuses that trend, scored again from the
//     stored statuses within bounded windows, and kept within their pools. In the Store's maintenance or readonly
//     state, it waits.
//   - polls: one round (domain/polls.ts): ends up to POLL_ROUND polls whose time has come (the 'poll' notifications,
//     once, and a local poll's final Update), and records up to POLL_ROUND Updates of local polls' counts that are due,
//     then rings the delivery doorbell for what they record. In the Store's maintenance or readonly state, they wait.
//   - OAuth: removes apps nobody used for a day (RES-6) and expired codes and web sessions (domain/oauth.ts).
//   - instance activity: deletes the counts and logins outside the kept days, at most ACTIVITY_PRUNE_ROWS of each
//     (domain/instance-activity.ts pruneActivity). In the Store's maintenance or readonly state, they wait.
export type ScheduledDeps = SweepDeps & {
  // Rings the delivery doorbell after statuses are published (default: a message on env.QUEUE).
  doorbell?: (env: Env) => Promise<void>;
  // The object id (uuid) of each status published.
  objectId?: () => string;
};

export async function handleScheduled(env: Env, deps: ScheduledDeps): Promise<void> {
  const config = readConfig(env);
  if (!config.ok || config.config.MAINTENANCE !== "off") {
    return;
  }
  // The marker /setup's cron check reads (domain/setup.ts).
  try {
    await callStore(() => deps.store(env).recordCronRun(deps.build(env), { now: deps.now() }));
  } catch (error) {
    if (!(error instanceof StoreUnavailableError)) {
      console.error({ event: "kopje.scheduled.cron_marker_failed", ...errorFields(error) });
    }
  }
  try {
    await publishScheduled(env, deps);
  } catch (error) {
    if (!(error instanceof StoreUnavailableError)) {
      console.error({ event: "kopje.scheduled.publish_round_failed", ...errorFields(error) });
    }
  }
  try {
    await callStore(() => deps.store(env).announcementRound(deps.build(env), { now: deps.now() }));
  } catch (error) {
    if (!(error instanceof StoreUnavailableError)) {
      console.error({ event: "kopje.scheduled.announcement_round_failed", ...errorFields(error) });
    }
  }
  try {
    await callStore(() => deps.store(env).trendsRound(deps.build(env), { now: deps.now() }));
  } catch (error) {
    if (!(error instanceof StoreUnavailableError)) {
      console.error({ event: "kopje.scheduled.trends_round_failed", ...errorFields(error) });
    }
  }
  try {
    await endPolls(env, deps);
  } catch (error) {
    if (!(error instanceof StoreUnavailableError)) {
      console.error({ event: "kopje.scheduled.poll_round_failed", ...errorFields(error) });
    }
  }
  try {
    await sweepMedia(env, deps);
  } catch (error) {
    console.error({ event: "kopje.scheduled.media_sweep_failed", ...errorFields(error) });
  }
  try {
    await reconcileMedia(env, deps);
  } catch (error) {
    console.error({ event: "kopje.scheduled.media_reconcile_failed", ...errorFields(error) });
  }
  try {
    await callStore(() => deps.store(env).sweepOAuth(deps.build(env), { now: deps.now() }));
  } catch (error) {
    if (!(error instanceof StoreUnavailableError)) {
      console.error({ event: "kopje.scheduled.oauth_sweep_failed", ...errorFields(error) });
    }
  }
  try {
    await callStore(() => deps.store(env).pruneActivity(deps.build(env), { now: deps.now() }));
  } catch (error) {
    if (!(error instanceof StoreUnavailableError)) {
      console.error({ event: "kopje.scheduled.activity_prune_failed", ...errorFields(error) });
    }
  }
}

// The cron's field link round (federation/field-links.ts), run first and on its own (worker.ts), so that no other
// scheduled work's failure skips it and its failure skips none: one claimed account per tick, outside the env's
// maintenance; in the Store's, the claim is refused before any request and the check waits for a later tick.
export async function scheduledFieldLinks(env: Env, deps: FieldLinksDeps): Promise<void> {
  const config = readConfig(env);
  if (!config.ok || config.config.MAINTENANCE !== "off") {
    return;
  }
  try {
    await fieldLinksRound(env, deps);
  } catch (error) {
    if (!(error instanceof StoreUnavailableError) && !(error instanceof DeadlinePassed)) {
      console.error({ event: "kopje.scheduled.field_links_failed", ...errorFields(error) });
    }
  }
}

// The cron's link card round (federation/link-cards.ts), on its own as the field link round is: at most
// CARD_ROUND_CLAIMS cards per tick, outside the env's maintenance; in the Store's, the claim is refused before any
// request and the cards wait for a later tick.
export async function scheduledLinkCards(env: Env, deps: LinkCardsDeps): Promise<void> {
  const config = readConfig(env);
  if (!config.ok || config.config.MAINTENANCE !== "off") {
    return;
  }
  try {
    await linkCardsRound(env, deps);
  } catch (error) {
    if (!(error instanceof StoreUnavailableError) && !(error instanceof DeadlinePassed)) {
      console.error({ event: "kopje.scheduled.link_cards_failed", ...errorFields(error) });
    }
  }
}

// The cron's card image round (federation/card-images.ts), on its own as the link card round is: at most
// CARD_IMAGE_ROUND_CLAIMS images per tick, outside the env's maintenance; in the Store's, the claim is refused before
// any request and the images wait for a later tick.
export async function scheduledCardImages(env: Env, deps: CardImagesDeps): Promise<void> {
  const config = readConfig(env);
  if (!config.ok || config.config.MAINTENANCE !== "off") {
    return;
  }
  try {
    await cardImagesRound(env, deps);
  } catch (error) {
    if (!(error instanceof StoreUnavailableError) && !(error instanceof DeadlinePassed)) {
      console.error({ event: "kopje.scheduled.card_images_failed", ...errorFields(error) });
    }
  }
}

// The cron's remote media round (federation/remote-media.ts), on its own as the card image round is: the cache's
// maintenance and at most LANE0_CLAIMS files per tick, outside the env's maintenance; in the Store's, the maintenance
// call is refused before any R2 operation or request, and the files wait for a later tick.
export async function scheduledRemoteMedia(env: Env, deps: RemoteMediaDeps): Promise<void> {
  const config = readConfig(env);
  if (!config.ok || config.config.MAINTENANCE !== "off") {
    return;
  }
  try {
    await remoteMediaRound(env, deps);
  } catch (error) {
    if (!(error instanceof StoreUnavailableError) && !(error instanceof DeadlinePassed)) {
      console.error({ event: "kopje.scheduled.remote_media_failed", ...errorFields(error) });
    }
  }
}

// One round of scheduled statuses (RES-6): at most PUBLISH_ROUND, the earliest due first.
export async function publishScheduled(env: Env, deps: ScheduledDeps): Promise<void> {
  const objectId = deps.objectId ?? (() => crypto.randomUUID());
  const objectIds = Array.from({ length: PUBLISH_ROUND }, objectId);
  const round = await callStore(() =>
    deps.store(env).publishScheduled(deps.build(env), { now: deps.now(), objectIds }),
  );
  if (round.failed > 0) {
    console.error({ event: "kopje.scheduled.publish_failed", failed: round.failed });
  }
  if (round.published > 0) {
    await (deps.doorbell ?? ((e: Env) => ringDoorbell(e.QUEUE)))(env);
  }
}

// One round of polls (RES-6): the ends and the Updates of counts that are due.
export async function endPolls(env: Env, deps: ScheduledDeps): Promise<void> {
  const round = await callStore(() => deps.store(env).pollRound(deps.build(env), { now: deps.now() }));
  if (round.ended > 0 || round.updated > 0) {
    await (deps.doorbell ?? ((e: Env) => ringDoorbell(e.QUEUE)))(env);
  }
}
