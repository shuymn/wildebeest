// A Content-Type header value as RFC 9110 §8.3.1 defines it: type "/" subtype *( OWS ";" OWS parameter ). The type,
// subtype and parameter names are case-insensitive and come back lowercased; a value may be a token or a quoted-string.
// The one exception: an unquoted profile may be a URI (not a token), so the ActivityStreams profile is accepted unquoted
// too. A header that does not parse is null, and so is a combined value (a ',' outside a quoted string) and a header
// that repeats a parameter, conflicting or not: no precedence rule decides which profile counts.
export type MediaType = { essence: string; parameters: Map<string, string> };

const TCHARS = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const TYPE = new RegExp(`^[\\t ]*(${TCHARS})/(${TCHARS})[\\t ]*`);
const TOKEN = new RegExp(`^${TCHARS}$`);
const PARAMETER = new RegExp(`;[\\t ]*(?:(${TCHARS})=(?:"((?:[^"\\\\]|\\\\.)*)"|([^\\t ;",]+)))?[\\t ]*`, "y");

export function parseMediaType(header: string): MediaType | null {
  const type = TYPE.exec(header);
  if (type === null) {
    return null;
  }
  const parameters = new Map<string, string>();
  PARAMETER.lastIndex = type[0].length;
  while (PARAMETER.lastIndex < header.length) {
    const parameter = PARAMETER.exec(header);
    if (parameter === null) {
      return null;
    }
    const [, rawName, quoted, unquoted] = parameter;
    if (rawName === undefined) {
      continue;
    }
    const name = rawName.toLowerCase();
    if (parameters.has(name) || (unquoted !== undefined && name !== "profile" && !TOKEN.test(unquoted))) {
      return null;
    }
    parameters.set(name, quoted?.replace(/\\(.)/g, "$1") ?? unquoted ?? "");
  }
  return { essence: `${type[1]!}/${type[2]!}`.toLowerCase(), parameters };
}

const ACTIVITYSTREAMS = "https://www.w3.org/ns/activitystreams";

// Whether a fetched document may be trusted as an ActivityPub object, as Mastodon's
// JsonLdHelper#valid_activitypub_content_type?: application/activity+json, or application/ld+json whose profile list
// names ActivityStreams. Plain JSON-LD and plain JSON are any file a server will host (GHSA-jhrq-qvrm-qr36).
export function isActivityPubMediaType(media: MediaType): boolean {
  if (media.essence === "application/activity+json") {
    return true;
  }
  const profile = media.parameters.get("profile");
  return (
    media.essence === "application/ld+json" &&
    profile !== undefined &&
    // An exact comparison with each listed profile URI, not a substring match.
    profile.split(/[\t ]+/).some((p) => p === ACTIVITYSTREAMS)
  );
}
