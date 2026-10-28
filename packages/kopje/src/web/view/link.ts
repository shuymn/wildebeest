import { httpUrl } from "../../platform/http-url";

// A link a page may emit (HTML-3): http(s) only. `external` is a URL on another host, which the page marks
// (rel="nofollow noopener" and an "Open on {host}" icon); no page browses remote items.
export type Link = { href: string; external: boolean; host: string };

// The link to a stored URL, or null when it is not http(s) (nothing is linked). A URL of the instance's own host is
// shortened to its path and query only when that short form, resolved against https://<domain>/, gives back exactly
// the same URL and its path does not start with `//` (which a browser would read as another host).
export function linkTo(url: string | null | undefined, domain: string): Link | null {
  const parsed = httpUrl(url ?? null);
  if (parsed === null) {
    return null;
  }
  const host = parsed.host;
  if (host !== domain) {
    return { href: parsed.href, external: true, host };
  }
  const short = `${parsed.pathname}${parsed.search}`;
  const local = !parsed.pathname.startsWith("//") && new URL(short, `https://${domain}/`).href === parsed.href;
  return { href: local ? short : parsed.href, external: false, host };
}
