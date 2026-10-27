# Streaming API Specification

This document specifies the Mastodon Streaming API for real-time updates via WebSocket or Server-Sent Events (SSE) connections.

## Status

This specification is normative for Mastodon v4.5.x implementations.

## Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

---

## 1. Host Discovery

The Streaming API MAY be served from a different hostname than the main REST API.

### 1.1 Discovery Methods

Clients MUST discover the streaming server URL using one of the following methods:

#### 1.1.1 Instance Configuration (Recommended)

Clients SHOULD extract the streaming URL from the instance configuration endpoint:

- **v2 Instance API**: `GET /api/v2/instance` returns `configuration.urls.streaming`
- **v1 Instance API**: `GET /api/v1/instance` returns `urls.streaming_api`

Example response fragment:
```json
{
  "configuration": {
    "urls": {
      "streaming": "wss://streaming.example.com"
    }
  }
}
```

#### 1.1.2 Redirect Discovery (Legacy)

Clients MAY make a request to `/api/v1/streaming` on the main host. The server:
- MUST redirect to the streaming server URL if a separate streaming host is configured
- MUST return `404 Not Found` if the same host should be used

### 1.2 Common URL Patterns

Streaming server URLs typically follow one of these patterns:
- `wss://streaming.{domain}` - Dedicated streaming subdomain
- `wss://{domain}` - Same domain as the main API
- `wss://{domain}/streaming` - Path-based routing

---

## 2. Connection

### 2.1 WebSocket Endpoint

**Endpoint**: `/api/v1/streaming`

Clients MUST establish a WebSocket connection to receive real-time events.

#### 2.1.1 Connection URL

```
wss://{streaming_host}/api/v1/streaming
```

#### 2.1.2 Protocol Requirements

- Clients MUST use the WebSocket Secure (`wss://`) protocol
- Clients MUST be configured to use text frames only; binary frames are not supported
- The server MUST close connections that send binary data with close code `1003` (Unsupported Data)

### 2.2 Authentication

All streaming connections REQUIRE authentication with a valid OAuth access token.

#### 2.2.1 Authentication Methods

Clients MUST authenticate using one of the following methods (in order of preference):

1. **Authorization Header** (Recommended)
   ```
   Authorization: Bearer <access_token>
   ```

2. **Sec-WebSocket-Protocol Header**
   ```
   Sec-WebSocket-Protocol: <access_token>
   ```

3. **Query Parameter** (Legacy, Not Recommended)
   ```
   wss://streaming.example.com/api/v1/streaming?access_token=<access_token>
   ```

> **Security Note**: The `access_token` query parameter SHOULD NOT be used in new implementations as query parameters may be logged in server access logs.

#### 2.2.2 Required OAuth Scopes

| Channel | Required Scope |
|---------|----------------|
| `user` | `read` or `read:statuses` (plus `read:notifications` for notifications) |
| `user:notification` | `read` or `read:notifications` |
| `public`, `public:local`, `public:remote` | `read` or `read:statuses` |
| `hashtag`, `hashtag:local` | `read` or `read:statuses` |
| `list` | `read` or `read:statuses` |
| `direct` | `read` or `read:statuses` |

#### 2.2.3 Authentication Errors

If authentication fails, the server:
- MUST reject the WebSocket upgrade request with an appropriate HTTP status code
- MUST include an `X-Error-Message` header with the error description

Example error response headers:
```
HTTP/1.1 401 Unauthorized
Connection: close
Content-Type: text/plain
X-Request-Id: abc123
X-Error-Message: Invalid access token
```

### 2.3 Health Check

**Endpoint**: `GET /api/v1/streaming/health`

Clients MAY verify streaming server availability before establishing a WebSocket connection.

#### Request

```http
GET /api/v1/streaming/health HTTP/1.1
Host: streaming.example.com
```

#### Response

**200 OK**
```
OK
```

Response headers:
- `Content-Type: text/plain`
- `Cache-Control: private, no-store`

---

## 3. Channels (Streams)

Channels define the type of events a client receives. Each channel provides a specific subset of real-time updates.

### 3.1 Available Channels

| Channel | Description | Authentication |
|---------|-------------|----------------|
| `user` | Authenticated user's home timeline and notifications | Required |
| `user:notification` | Notifications only for the authenticated user | Required |
| `public` | Federated public timeline (all known public posts) | Required |
| `public:local` | Local public timeline (posts from this server only) | Required |
| `public:remote` | Remote public timeline (posts from other servers only) | Required |
| `public:media` | Federated public timeline, media attachments only | Required |
| `public:local:media` | Local public timeline, media attachments only | Required |
| `public:remote:media` | Remote public timeline, media attachments only | Required |
| `hashtag` | All public posts with a specific hashtag | Required |
| `hashtag:local` | Local public posts with a specific hashtag | Required |
| `list` | Updates from a specific list | Required |
| `direct` | Direct message conversations | Required |

### 3.2 Channel Parameters

Some channels require additional parameters:

| Channel | Required Parameter | Description |
|---------|-------------------|-------------|
| `hashtag` | `tag` | The hashtag name (without `#` prefix) |
| `hashtag:local` | `tag` | The hashtag name (without `#` prefix) |
| `list` | `list` | The list ID |
| `public`, `public:local`, `public:remote` | `only_media` (optional) | Boolean, filter for media attachments |

### 3.3 Channel Events

Each channel emits specific event types:

| Channel | Events |
|---------|--------|
| `user` | `update`, `delete`, `notification`, `filters_changed`, `announcement`, `announcement.reaction`, `announcement.delete`, `status.update`, `notifications_merged` |
| `user:notification` | `notification`, `notifications_merged` |
| `public`, `public:local`, `public:remote` | `update`, `delete`, `status.update` |
| `public:media`, `public:local:media`, `public:remote:media` | `update`, `delete`, `status.update` |
| `hashtag`, `hashtag:local` | `update`, `delete`, `status.update` |
| `list` | `update`, `delete`, `status.update` |
| `direct` | `conversation` |

---

## 4. Subscription Management

### 4.1 WebSocket Subscription

After establishing a WebSocket connection, clients subscribe to channels by sending JSON messages.

#### 4.1.1 Subscribe Message

Clients MUST send a JSON message with the following structure:

```json
{
  "type": "subscribe",
  "stream": "<channel_name>"
}
```

For channels requiring parameters:

```json
{
  "type": "subscribe",
  "stream": "hashtag",
  "tag": "mastodon"
}
```

```json
{
  "type": "subscribe",
  "stream": "list",
  "list": "12345"
}
```

#### 4.1.2 Unsubscribe Message

Clients MUST send a JSON message to stop receiving events from a channel:

```json
{
  "type": "unsubscribe",
  "stream": "<channel_name>"
}
```

For parameterized channels:

```json
{
  "type": "unsubscribe",
  "stream": "hashtag",
  "tag": "mastodon"
}
```

#### 4.1.3 Initial Subscription via Query Parameter

Clients MAY specify an initial channel subscription via query parameter:

```
wss://streaming.example.com/api/v1/streaming?stream=user
```

With parameters:
```
wss://streaming.example.com/api/v1/streaming?stream=hashtag&tag=mastodon
```

```
wss://streaming.example.com/api/v1/streaming?stream=list&list=12345
```

### 4.2 Server-Sent Events (SSE)

For HTTP SSE connections, clients subscribe by connecting to stream-specific endpoints:

| Endpoint | Channel |
|----------|---------|
| `GET /api/v1/streaming/user` | `user` |
| `GET /api/v1/streaming/user/notification` | `user:notification` |
| `GET /api/v1/streaming/public` | `public` |
| `GET /api/v1/streaming/public/local` | `public:local` |
| `GET /api/v1/streaming/public/remote` | `public:remote` |
| `GET /api/v1/streaming/hashtag?tag={tag}` | `hashtag` |
| `GET /api/v1/streaming/hashtag/local?tag={tag}` | `hashtag:local` |
| `GET /api/v1/streaming/list?list={id}` | `list` |
| `GET /api/v1/streaming/direct` | `direct` |

Query parameters:
- `only_media=true` - For public timelines, filter for posts with media attachments

### 4.3 Multiple Stream Subscriptions

A single WebSocket connection MAY subscribe to multiple streams simultaneously.

Example: Subscribe to both user and public streams:
```json
{"type": "subscribe", "stream": "user"}
{"type": "subscribe", "stream": "public"}
```

---

## 5. Event Format

### 5.1 WebSocket Event Format

Events are delivered as JSON-encoded text frames:

```json
{
  "stream": ["<channel_name>"],
  "event": "<event_type>",
  "payload": "<json_string_or_id>"
}
```

#### 5.1.1 Field Definitions

| Field | Type | Description |
|-------|------|-------------|
| `stream` | `string[]` | Array containing the channel name(s) this event belongs to |
| `event` | `string` | The event type identifier |
| `payload` | `string` | JSON-encoded string of the entity, or a plain string ID for delete events |

#### 5.1.2 Stream Array Format

The `stream` array contains the channel identifier(s). For parameterized channels, additional elements are included:

| Channel | Stream Array Example |
|---------|---------------------|
| `user` | `["user"]` |
| `public` | `["public"]` |
| `hashtag` with tag "mastodon" | `["hashtag", "mastodon"]` |
| `list` with ID "12345" | `["list", "12345"]` |

#### 5.1.3 Payload Encoding

> **Important**: The `payload` field is a JSON-encoded string that MUST be parsed separately.

For `update`, `notification`, `conversation`, `announcement`, and `status.update` events:
```json
{
  "stream": ["user"],
  "event": "update",
  "payload": "{\"id\":\"123\",\"content\":\"<p>Hello</p>\",...}"
}
```

For `delete` and `announcement.delete` events, the payload is a plain string ID:
```json
{
  "stream": ["public"],
  "event": "delete",
  "payload": "108914398911648589"
}
```

For `filters_changed` events, the payload MAY be absent:
```json
{
  "stream": ["user"],
  "event": "filters_changed"
}
```

### 5.2 SSE Event Format

Server-Sent Events follow the standard SSE format:

```
event: <event_type>
data: <payload>

```

Example:
```
event: update
data: {"id":"123","content":"<p>Hello</p>",...}

```

#### 5.2.1 Heartbeat Comments

The server sends periodic heartbeat comments to keep the connection alive:

```
:thump
```

Lines beginning with `:` MUST be ignored by parsers.

---

## 6. Event Types

### 6.1 Status Events

#### `update`

A new status has appeared in the timeline.

**Payload**: JSON-encoded [Status](../entities/status.md) entity

**Available on**: `user`, `public`, `public:local`, `public:remote`, `public:media`, `public:local:media`, `public:remote:media`, `hashtag`, `hashtag:local`, `list`

Example:
```json
{
  "stream": ["public"],
  "event": "update",
  "payload": "{\"id\":\"108914354907984653\",\"created_at\":\"2022-08-30T23:12:47.000Z\",\"visibility\":\"public\",\"content\":\"<p>Hello world</p>\",...}"
}
```

#### `status.update`

A status has been edited.

**Payload**: JSON-encoded [Status](../entities/status.md) entity with updated content

**Available on**: `user`, `public`, `public:local`, `public:remote`, `public:media`, `public:local:media`, `public:remote:media`, `hashtag`, `hashtag:local`, `list`

Example:
```json
{
  "stream": ["public"],
  "event": "status.update",
  "payload": "{\"id\":\"108914354907984653\",\"edited_at\":\"2022-08-30T23:15:00.000Z\",\"content\":\"<p>Hello world (edited)</p>\",...}"
}
```

#### `delete`

A status has been deleted.

**Payload**: String ID of the deleted status

**Available on**: `user`, `public`, `public:local`, `public:remote`, `public:media`, `public:local:media`, `public:remote:media`, `hashtag`, `hashtag:local`, `list`

Example:
```json
{
  "stream": ["public"],
  "event": "delete",
  "payload": "108914354907984653"
}
```

### 6.2 Notification Events

#### `notification`

A new notification has been received.

**Payload**: JSON-encoded [Notification](../entities/notification.md) entity

**Available on**: `user`, `user:notification`

Example:
```json
{
  "stream": ["user"],
  "event": "notification",
  "payload": "{\"id\":\"68739215\",\"type\":\"mention\",\"created_at\":\"2022-08-30T23:09:54.070Z\",\"account\":{...},\"status\":{...}}"
}
```

#### `notifications_merged`

Notification requests have finished merging and the notifications list should be refreshed.

**Payload**: MAY be ignored

**Available on**: `user`, `user:notification`

### 6.3 Conversation Events

#### `conversation`

A direct message conversation has been updated.

**Payload**: JSON-encoded [Conversation](../entities/conversation.md) entity

**Available on**: `direct`

Example:
```json
{
  "stream": ["direct"],
  "event": "conversation",
  "payload": "{\"id\":\"819516\",\"unread\":true,\"accounts\":[...],\"last_status\":{...}}"
}
```

### 6.4 Filter Events

#### `filters_changed`

The user's keyword filters have been changed.

**Payload**: None (WebSocket) or `undefined` (SSE)

**Available on**: `user`

Example (WebSocket):
```json
{
  "stream": ["user"],
  "event": "filters_changed"
}
```

Example (SSE):
```
event: filters_changed
data: undefined

```

### 6.5 Announcement Events

#### `announcement`

A new instance announcement has been published.

**Payload**: JSON-encoded [Announcement](../entities/announcement.md) entity

**Available on**: `user`

Example:
```json
{
  "stream": ["user"],
  "event": "announcement",
  "payload": "{\"id\":\"1\",\"content\":\"<p>Welcome!</p>\",\"starts_at\":null,\"ends_at\":null,\"all_day\":true,...}"
}
```

#### `announcement.reaction`

A reaction has been added to an announcement.

**Payload**: JSON-encoded object with `name`, `count`, and `announcement_id`

**Available on**: `user`

Example:
```json
{
  "stream": ["user"],
  "event": "announcement.reaction",
  "payload": "{\"name\":\"thumbsup\",\"count\":5,\"announcement_id\":\"1\"}"
}
```

#### `announcement.delete`

An announcement has been deleted.

**Payload**: String ID of the deleted announcement

**Available on**: `user`

Example:
```json
{
  "stream": ["user"],
  "event": "announcement.delete",
  "payload": "1"
}
```

### 6.6 Encrypted Message Events

#### `encrypted_message`

An encrypted message has been received (for end-to-end encryption features).

**Payload**: Encrypted message data

**Available on**: `user`

> **Note**: This event type is implemented but currently unused in production.

---

## 7. Connection Management

### 7.1 Keep-Alive

#### 7.1.1 WebSocket Ping/Pong

The server sends WebSocket ping frames every 30 seconds. Clients:
- MUST respond to ping frames with pong frames
- Will be disconnected if they fail to respond (connection considered dead)

#### 7.1.2 SSE Heartbeat

For SSE connections, the server sends heartbeat comments every 15 seconds:
```
:thump
```

### 7.2 Reconnection

Clients SHOULD implement automatic reconnection with exponential backoff:

1. Initial reconnection delay: 1 second
2. Maximum reconnection delay: 30 seconds
3. Backoff multiplier: 2x after each failed attempt

### 7.3 Error Handling

#### 7.3.1 Subscription Errors

If a subscription fails, the server sends an error message:

```json
{
  "error": "Access token does not have the required scopes",
  "status": 401
}
```

#### 7.3.2 Connection Termination

The server MAY terminate connections when:
- The access token is revoked
- The user's account is suspended or disabled
- The server is shutting down

Clients will receive a close frame and SHOULD attempt to reconnect.

---

## 8. Examples

### 8.1 WebSocket Connection Example

```javascript
// Establish connection
const ws = new WebSocket(
  'wss://streaming.example.com/api/v1/streaming',
  accessToken  // Using Sec-WebSocket-Protocol
);

// Or with Authorization header (requires custom WebSocket implementation)
// const ws = new WebSocket('wss://streaming.example.com/api/v1/streaming');
// ws.setRequestHeader('Authorization', `Bearer ${accessToken}`);

ws.onopen = () => {
  // Subscribe to user stream
  ws.send(JSON.stringify({
    type: 'subscribe',
    stream: 'user'
  }));

  // Subscribe to a hashtag
  ws.send(JSON.stringify({
    type: 'subscribe',
    stream: 'hashtag',
    tag: 'mastodon'
  }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);

  // Check for errors
  if (data.error) {
    console.error('Stream error:', data.error);
    return;
  }

  // Handle events
  switch (data.event) {
    case 'update':
      const status = JSON.parse(data.payload);
      console.log('New status:', status.id);
      break;
    case 'delete':
      console.log('Deleted status:', data.payload);
      break;
    case 'notification':
      const notification = JSON.parse(data.payload);
      console.log('Notification:', notification.type);
      break;
  }
};

ws.onclose = (event) => {
  console.log('Connection closed:', event.code, event.reason);
  // Implement reconnection logic
};
```

### 8.2 SSE Connection Example

```javascript
// Establish SSE connection to user stream
const eventSource = new EventSource(
  'https://streaming.example.com/api/v1/streaming/user',
  {
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  }
);

eventSource.addEventListener('update', (event) => {
  const status = JSON.parse(event.data);
  console.log('New status:', status.id);
});

eventSource.addEventListener('notification', (event) => {
  const notification = JSON.parse(event.data);
  console.log('Notification:', notification.type);
});

eventSource.addEventListener('delete', (event) => {
  console.log('Deleted status:', event.data);
});

eventSource.onerror = (error) => {
  console.error('SSE error:', error);
};
```

### 8.3 Subscribe/Unsubscribe Flow

```javascript
// Subscribe to public timeline
ws.send(JSON.stringify({
  type: 'subscribe',
  stream: 'public'
}));

// Later, unsubscribe
ws.send(JSON.stringify({
  type: 'unsubscribe',
  stream: 'public'
}));

// Subscribe to list
ws.send(JSON.stringify({
  type: 'subscribe',
  stream: 'list',
  list: '12345'
}));

// Unsubscribe from list
ws.send(JSON.stringify({
  type: 'unsubscribe',
  stream: 'list',
  list: '12345'
}));
```

---

## 9. Implementation Notes

### 9.1 Filtering

For public timeline streams (`public`, `public:local`, `public:remote`, `hashtag`, `hashtag:local`), the streaming server applies:

1. **Language filtering**: Based on user's preferred languages
2. **Block/Mute filtering**: Statuses from blocked or muted accounts are filtered
3. **Domain block filtering**: Statuses from blocked domains are filtered
4. **Custom keyword filters**: User-defined content filters are applied

### 9.2 System Channels

The server internally maintains system channels for:
- Access token invalidation (forces connection close)
- Filter cache invalidation

These are not directly subscribable by clients but affect their connections.

### 9.3 Rate Limiting

The streaming server does not impose explicit rate limits on subscriptions, but:
- Excessive subscription changes MAY result in temporary blocks
- Connections are subject to overall server resource limits

---

## 10. Version History

| Version | Changes |
|---------|---------|
| 4.3.0 | Added `notifications_merged` event |
| 4.2.0 | Removed public/app token access, requiring user tokens for all streams |
| 3.5.0 | Added `status.update` event for edited statuses |
| 3.3.0 | Added WebSocket multiplexing support |
| 3.2.0 | Added `encrypted_message` event (unused) |
| 3.1.4 | Added `public:remote` and `public:remote:media` streams |
| 3.1.0 | Added announcement events |
| 2.6.0 | Changed `direct` stream to return `conversation` events |
| 2.5.0 | Added health check endpoint |
| 2.4.3 | Added `filters_changed` event |
| 2.4.0 | Added `direct` stream, `only_media` filter, media-filtered streams |
| 2.1.0 | Added `list` stream |
| 1.4.2 | Added `user:notification` stream, `notification` event |
| 1.1.0 | Added `public:local` and `hashtag:local` streams |
| 1.0.0 | Initial streaming API |
