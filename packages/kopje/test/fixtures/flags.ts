import { mastodonActor, MASTODON, MISSKEY, misskeyActor, type RemoteWeb, type TestActor } from "../inbox-helpers";

// Inbound Flags as the software that sends them renders them (Mastodon 4.5.11, Misskey 2026.10.0): synthetic
// servers, never real ones.

const AS = "https://www.w3.org/ns/activitystreams";

// Mastodon's instance actor (Account.representative), an Application at /actor, which signs a forwarded report.
export function mastodonInstanceActor(web: RemoteWeb): Promise<TestActor> {
  return mastodonActor(web, "mastodon.example", {
    uri: `${MASTODON}/actor`,
    extra: { type: "Application", url: `${MASTODON}/about/more?instance_actor=true` },
  });
}

// Misskey's system actor (SystemAccountService 'actor'), an Application, which signs a forwarded report.
export function misskeySystemActor(web: RemoteWeb): Promise<TestActor> {
  return misskeyActor(web, "9system000", "actor", { extra: { type: "Application" } });
}

let sequence = 0;

// ActivityPub::FlagSerializer: the id from TagManager#generate_uri_for (root/payloads/<uuid>), the reported account's
// uri first and then its statuses' (object), and the comment (content).
export function mastodonFlag(actor: TestActor, objects: readonly string[], comment: string, id?: string) {
  return {
    "@context": AS,
    id: id ?? `${new URL(actor.uri).origin}/payloads/00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    type: "Flag",
    actor: actor.uri,
    content: comment,
    object: [...objects],
  };
}

// ApRendererService#renderFlag with addContext: the reported account's uri alone as the object (a string), the
// comment as plain text, and the id `${url}/<uuid>`.
export function misskeyFlag(actor: TestActor, target: string, comment: string) {
  return {
    "@context": [AS, "https://w3id.org/security/v1"],
    type: "Flag",
    actor: actor.uri,
    content: comment,
    object: target,
    id: `${MISSKEY}/0a1b2c3d-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  };
}
