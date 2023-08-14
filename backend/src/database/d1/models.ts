// Code generated by sqlc-gen-ts-d1. DO NOT EDIT.
// versions:
//   sqlc v1.20.0
//   sqlc-gen-ts-d1 v0.0.0-a@9af07320cda61bba7e9ed9a216e0c87d9e5e49c1

export type Actors = {
  id: string;
  mastodonId: string | null;
  type: string | null;
  username: string | null;
  domain: string | null;
  properties: string;
  cdate: string;
};

export type ActorFollowing = {
  id: string;
  actorId: string;
  targetActorId: string;
  targetActorAcct: string;
  state: string;
  cdate: string;
};

export type Objects = {
  id: string;
  mastodonId: string;
  type: string;
  cdate: string;
  originalActorId: string | null;
  originalObjectId: string | null;
  replyToObjectId: string | null;
  properties: string;
  local: number;
};

export type InboxObjects = {
  id: string;
  actorId: string;
  objectId: string;
  cdate: string;
};

export type ActorNotifications = {
  id: number;
  type: string;
  actorId: string;
  fromActorId: string;
  objectId: string | null;
  cdate: string;
};

export type ActorFavourites = {
  id: string;
  actorId: string;
  objectId: string;
  cdate: string;
};

export type Clients = {
  id: string;
  secret: string;
  name: string;
  redirectUris: string;
  website: string | null;
  scopes: string | null;
  cdate: string;
};

export type SearchFtsData = {
  id: number;
  block: ArrayBuffer | null;
};

export type SearchFtsIdx = {
  segid: number | string | null;
  term: number | string | null;
  pgno: number | string | null;
};

export type SearchFtsContent = {
  id: number;
  c0: number | string | null;
  c1: number | string | null;
  c2: number | string | null;
  c3: number | string | null;
};

export type SearchFtsDocsize = {
  id: number;
  sz: ArrayBuffer | null;
};

export type SearchFtsConfig = {
  k: number | string | null;
  v: number | string | null;
};

export type ActorReplies = {
  id: string;
  actorId: string;
  objectId: string;
  inReplyToObjectId: string;
  cdate: string;
};

export type Peers = {
  domain: string;
};

export type IdempotencyKeys = {
  key: string;
  objectId: string;
  expiresAt: string;
};

export type NoteHashtags = {
  value: string;
  objectId: string;
  cdate: string;
};

export type Subscriptions = {
  id: number;
  actorId: string;
  clientId: string;
  endpoint: string;
  keyP256dh: string;
  keyAuth: string;
  alertMention: number;
  alertStatus: number;
  alertReblog: number;
  alertFollow: number;
  alertFollowRequest: number;
  alertFavourite: number;
  alertPoll: number;
  alertUpdate: number;
  alertAdminSignUp: number;
  alertAdminReport: number;
  policy: string;
  cdate: string;
};

export type ServerSettings = {
  settingName: string;
  settingValue: string;
};

export type ServerRules = {
  id: number;
  text: string;
};

export type ActorPreferences = {
  id: string;
  postingDefaultVisibility: string;
  postingDefaultSensitive: number;
  postingDefaultLanguage: string | null;
  readingExpandMedia: string;
  readingExpandSpoilers: number;
};

export type IdSequences = {
  key: string;
  value: number;
};

export type ClientCredentials = {
  id: string;
  clientId: string;
  accessToken: string;
  scopes: string;
  cdate: string;
};

export type ActorActivities = {
  id: string;
  actorId: string;
  type: string;
  cdate: string;
  activity: string;
};

export type OutboxObjects = {
  id: string;
  actorId: string;
  objectId: string;
  cdate: string;
  publishedDate: string;
  to: string;
  cc: string;
};

export type ActorReblogs = {
  id: string;
  mastodonId: string;
  actorId: string;
  objectId: string;
  outboxObjectId: string;
  cdate: string;
};

export type Users = {
  id: string;
  actorId: string;
  email: string;
  privkey: ArrayBuffer;
  privkeySalt: ArrayBuffer;
  pubkey: string;
  isAdmin: number;
  cdate: string;
};
