# Host-Meta Discovery

This document specifies the Host-Meta endpoint for Mastodon-compatible servers, implementing [RFC 6415](https://www.rfc-editor.org/rfc/rfc6415).

## Endpoint

```
GET /.well-known/host-meta
```

## Purpose

The Host-Meta endpoint provides a discovery document that enables clients to locate the WebFinger endpoint. It returns a Link-based Resource Descriptor Document (LRDD) template that maps resource identifiers to their WebFinger URLs.

## Request

### Accept Header

The endpoint supports content negotiation:

| Accept Header | Response Format |
|--------------|-----------------|
| `application/xrd+xml` (default) | XRD (XML) format |
| `application/json` | JSON format |
| `*/*` or missing | XRD (XML) format |

## Response

### XRD (XML) Format

#### Content Type

```
Content-Type: application/xrd+xml; charset=utf-8
```

#### Response Structure

```xml
<?xml version="1.0" encoding="UTF-8"?>
<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">
  <Link rel="lrdd" template="https://mastodon.social/.well-known/webfinger?resource={uri}"/>
</XRD>
```

### JSON Format

#### Content Type

```
Content-Type: application/json; charset=utf-8
```

#### Response Structure

```json
{
  "links": [
    {
      "rel": "lrdd",
      "template": "https://mastodon.social/.well-known/webfinger?resource={uri}"
    }
  ]
}
```

### Response Fields

#### Link Element/Object

| Field | Type | Description |
|-------|------|-------------|
| `rel` | string | Link relation type, always `"lrdd"` |
| `template` | string | URI template for WebFinger lookups |

#### Template Format

The template follows [RFC 6570](https://www.rfc-editor.org/rfc/rfc6570) URI Template syntax:

```
https://{domain}/.well-known/webfinger?resource={uri}
```

Where:
- `{domain}` is the server's web domain
- `{uri}` is a placeholder to be replaced with the resource identifier

### LRDD (Link-based Resource Descriptor Discovery)

The `lrdd` link relation indicates that the template can be used to discover information about a resource. Clients replace the `{uri}` placeholder with the resource they want to look up.

**Example Usage:**

To look up `acct:alice@mastodon.social`:

1. Start with template: `https://mastodon.social/.well-known/webfinger?resource={uri}`
2. Replace `{uri}` with `acct:alice@mastodon.social`
3. Result: `https://mastodon.social/.well-known/webfinger?resource=acct:alice@mastodon.social`

## Status Codes

| Code | Description |
|------|-------------|
| 200 | Success |

## Caching

```
Cache-Control: max-age=259200, public
```

- HTTP cache duration: 3 days
- Responses MAY be cached by intermediaries

## Examples

### XRD Request

```http
GET /.well-known/host-meta HTTP/1.1
Host: mastodon.social
Accept: application/xrd+xml
```

### XRD Response

```http
HTTP/1.1 200 OK
Content-Type: application/xrd+xml; charset=utf-8
Cache-Control: max-age=259200, public

<?xml version="1.0" encoding="UTF-8"?>
<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">
  <Link rel="lrdd" template="https://mastodon.social/.well-known/webfinger?resource={uri}"/>
</XRD>
```

### JSON Request

```http
GET /.well-known/host-meta HTTP/1.1
Host: mastodon.social
Accept: application/json
```

### JSON Response

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Cache-Control: max-age=259200, public

{
  "links": [
    {
      "rel": "lrdd",
      "template": "https://mastodon.social/.well-known/webfinger?resource={uri}"
    }
  ]
}
```

### Default Request (No Accept Header)

```http
GET /.well-known/host-meta HTTP/1.1
Host: mastodon.social
```

Returns XRD (XML) format by default.

## Implementation Requirements

### Servers MUST:

1. Provide the endpoint at `/.well-known/host-meta`
2. Return XRD format by default when no `Accept` header or `*/*` is specified
3. Include the `lrdd` link with a valid WebFinger template
4. Use the correct namespace (`http://docs.oasis-open.org/ns/xri/xrd-1.0`) in XRD responses
5. Generate valid XML with proper encoding declaration

### Servers SHOULD:

1. Support content negotiation for JSON format
2. Use appropriate caching headers (3 days recommended)
3. Use the web domain in the template URL

### Servers MAY:

1. Include additional links in the response
2. Support additional content types

## XRD Namespace

The XRD document MUST use the following namespace:

```
xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"
```

This namespace is defined by the OASIS XRI Technical Committee.

## Relationship to WebFinger

Host-Meta and WebFinger work together for resource discovery:

1. **Host-Meta** provides the template for constructing WebFinger URLs
2. **WebFinger** returns detailed information about specific resources

While many implementations query WebFinger directly (the well-known path is standardized), Host-Meta provides a fallback discovery mechanism and is required for full RFC 6415 compliance.

```
Client                          Server
  |                               |
  |  GET /.well-known/host-meta   |
  |------------------------------>|
  |                               |
  |  LRDD template                |
  |<------------------------------|
  |                               |
  |  GET /.well-known/webfinger?  |
  |     resource=acct:user@domain |
  |------------------------------>|
  |                               |
  |  Account information (JRD)    |
  |<------------------------------|
```

## Security Considerations

1. The endpoint is publicly accessible without authentication
2. No sensitive information is exposed
3. The template URL should use HTTPS
4. Clients SHOULD validate the template domain matches the host

## Related Specifications

- [RFC 6415 - Web Host Metadata](https://www.rfc-editor.org/rfc/rfc6415)
- [RFC 6570 - URI Template](https://www.rfc-editor.org/rfc/rfc6570)
- [RFC 7033 - WebFinger](https://www.rfc-editor.org/rfc/rfc7033)
- [XRD 1.0 - Extensible Resource Descriptor](http://docs.oasis-open.org/xri/xrd/v1.0/xrd-1.0.html)
