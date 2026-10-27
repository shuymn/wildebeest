# Federation

This section documents the ActivityPub federation protocol and related security mechanisms for Mastodon-compatible servers.

## Overview

Mastodon implements the [ActivityPub](https://www.w3.org/TR/activitypub/) protocol for server-to-server (S2S) federation. Federation enables:

- Discovering users across instances
- Following remote accounts
- Delivering posts and activities across servers
- Synchronizing reactions (likes, boosts, replies)

## Content Types

Federation endpoints MUST support these content types:

| Content Type | Usage |
|--------------|-------|
| `application/activity+json` | Preferred for ActivityPub |
| `application/ld+json; profile="https://www.w3.org/ns/activitystreams"` | W3C standard format |

Servers SHOULD accept both and respond with `application/activity+json`.

## JSON-LD Context

ActivityPub objects MUST include the `@context` property:

```json
{
  "@context": [
    "https://www.w3.org/ns/activitystreams",
    "https://w3id.org/security/v1",
    {
      "manuallyApprovesFollowers": "as:manuallyApprovesFollowers",
      "toot": "http://joinmastodon.org/ns#",
      "featured": { "@id": "toot:featured", "@type": "@id" }
    }
  ]
}
```

## Actor Model

Actors (users) are represented by their ActivityPub profile URL:

- Format: `https://{domain}/users/{username}`
- Actors have inbox, outbox, followers, following collections
- Public keys are embedded in the actor document

## Documents

| Document | Description |
|----------|-------------|
| [Security & Signatures](security-signatures.md) | HTTP Signature verification requirements |
| [ActivityPub Endpoints](activitypub.md) | Inbox, Outbox, Actor, and Collection endpoints |
| [Authorized Fetch](authorized-fetch.md) | Secure mode requiring signed requests |

## Quick Reference

### Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/users/{username}` | GET | Optional* | Actor profile |
| `/users/{username}/inbox` | POST | Required | Receive activities (user inbox) |
| `/actor/inbox` | POST | Required | Receive activities (instance actor inbox) |
| `/inbox` | POST | Required | Receive activities (shared inbox) |
| `/users/{username}/outbox` | GET | Optional* | List activities |
| `/actor/outbox` | GET | Optional* | Instance actor outbox |
| `/users/{username}/followers` | GET | Optional* | Followers collection |
| `/users/{username}/following` | GET | Optional* | Following collection |
| `/users/{username}/collections/featured` | GET | Optional* | Pinned posts |
| `/users/{username}/collections/tags` | GET | Optional* | Featured tags |
| `/users/{username}/followers_synchronization` | GET | Required | Followers synchronization (signed) |
| `/users/{username}/quote_authorizations/{id}` | GET | Optional* | Quote authorization lookup |
| `/users/{username}/statuses/{id}` | GET | Optional* | Status as ActivityPub `Note` |
| `/users/{username}/statuses/{id}/activity` | GET | Optional* | Status as ActivityPub `Create` activity |
| `/users/{username}/statuses/{id}/replies` | GET | Optional* | Replies collection |
| `/users/{username}/statuses/{id}/likes` | GET | Optional* | Likes collection |
| `/users/{username}/statuses/{id}/shares` | GET | Optional* | Shares collection |

*Signature required in Authorized Fetch mode

### Common Activity Types

| Activity | Purpose |
|----------|---------|
| `Create` | New post, reply, or object |
| `Update` | Edit existing object |
| `Delete` | Remove object |
| `Follow` | Request to follow |
| `Accept` | Accept follow request |
| `Reject` | Reject follow request |
| `Undo` | Reverse previous activity |
| `Announce` | Boost/share |
| `Like` | Favourite |
