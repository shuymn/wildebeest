import { type Child, type FC, jsx, useContext } from "hono/jsx";

import type { IconName } from "../icons";
import type { SafeHtml } from "../safe-html";
import { useUi } from "../ui";
import type { Link } from "../view/link";
import { Icon } from "./icon";
import { L1Context } from "./layout";

// The small parts every page shares.

// Stored HTML, sanitized at its sink (SafeHtml, HTML-1), with the content's language when known.
export const Rich: FC<{ html: SafeHtml; class: string; lang?: string }> = ({ html, class: className, lang }) => (
  <div class={className} lang={lang} dangerouslySetInnerHTML={{ __html: html.html }} />
);

// An instant carries data-local (rewritten to the viewer's zone by the L1 bundle) only on a page that
// loads the bundle (L1Context); elsewhere it keeps the server's full UTC text unmarked, since nothing rewrites it. A
// calendar date never carries it. true is the compact shape, 'full' and 'deadline' the exceptions
// (src/client/local-time.ts).
export const DateTime: FC<{ iso: string; text: string; local: boolean | "full" | "deadline" }> = ({
  iso,
  text,
  local,
}) => {
  const l1 = useContext(L1Context);
  return (
    <time datetime={iso} data-local={!l1 || local === false ? undefined : local === true ? "" : local}>
      {text}
    </time>
  );
};

export const VisuallyHidden: FC<{ children?: Child }> = ({ children }) => <span class="vh">{children}</span>;

export const Card: FC<{
  as?: "section" | "article" | "div" | "ol" | "dl";
  class?: string;
  role?: "list";
  children?: Child;
}> = ({ as = "div", class: className, role, children }) =>
  jsx(as, { class: className === undefined ? "card" : `card ${className}`, role }, children);

// A link to a Link: one on another host opens nothing of this site's and says where it goes, in hidden text naming that
// server. No icon marks it: the address or host beside such a link already shows the server, and one rule keeps every
// remote link alike.
export const LinkTo: FC<{ link: Link; class?: string; children?: Child }> = ({ link, class: className, children }) => {
  const { m } = useUi();
  return link.external ? (
    <a class={className} href={link.href} rel="nofollow noopener">
      {children}
      <span class="vh">{` ${m.a11y.openOn(link.host)}`}</span>
    </a>
  ) : (
    <a class={className} href={link.href}>
      {children}
    </a>
  );
};

// A link back where the viewer came from, above a page's heading: navigation, not one of the page's actions.
export const BackLink: FC<{ href: string; label: string }> = ({ href, label }) => (
  <a class="quiet-link" href={href}>
    <Icon name="back" size={16} decorative />
    {label}
  </a>
);

type ButtonVariant = "primary" | "default" | "quiet";

// An icon before or after a button's text: `end` puts it after (a pager's onward link).
type ButtonIcon = { name: IconName; end?: boolean };

const withIcon = (icon: ButtonIcon | undefined, children: Child) => {
  const svg = icon === undefined ? null : <Icon name={icon.name} size={18} decorative />;
  return icon?.end === true ? (
    <>
      {children}
      {svg}
    </>
  ) : (
    <>
      {svg}
      {children}
    </>
  );
};

// `label`: the accessible name, when the visible text is a shortened form of it (a narrow pager's).
export const LinkButton: FC<{
  href: string;
  variant?: ButtonVariant;
  icon?: ButtonIcon;
  label?: string;
  // A pager's link's relation to this page: rel="prev" or "next".
  rel?: "prev" | "next";
  children?: Child;
}> = ({ href, variant = "default", icon, label, rel, children }) => (
  <a class={variant === "default" ? "btn" : `btn ${variant}`} href={href} aria-label={label} rel={rel}>
    {withIcon(icon, children)}
  </a>
);

// The labels of a pager's two sides: in full, and the short forms a narrow pager shows (the full one stays the name).
export type PagerTexts = { newer: string; older: string; newerShort: string; olderShort: string };

// Newer and older pages, or earlier and later ones (`texts`): each side only when it is offered, the older one at the
// row's end; nothing when neither is.
export const Pager: FC<{ newer: string | null; older: string | null; texts: PagerTexts }> = ({
  newer,
  older,
  texts,
}) => {
  const { m } = useUi();
  const side = (href: string, full: string, short: string, older: boolean) => (
    <LinkButton
      href={href}
      icon={older ? { name: "next", end: true } : { name: "back" }}
      label={full}
      rel={older ? "next" : "prev"}
    >
      <span class="long">{full}</span>
      <span class="short">{short}</span>
    </LinkButton>
  );
  return newer === null && older === null ? null : (
    <nav class="pager" aria-label={m.a11y.pages}>
      {newer === null ? null : side(newer, texts.newer, texts.newerShort, false)}
      {older === null ? null : side(older, texts.older, texts.olderShort, true)}
    </nav>
  );
};

// A paged list: the list, then its pager. An empty page that links on shows only its pager; the empty
// line shows only when no page lies either way. Posts, accounts and a status's replies all page through this.
export const PagedList: FC<{
  empty: boolean;
  emptyText: Child;
  pager: { newer: string | null; older: string | null };
  texts: PagerTexts;
  children?: Child;
}> = ({ empty, emptyText, pager, texts, children }) => (
  <>
    {empty ? pager.newer === null && pager.older === null ? <p class="muted">{emptyText}</p> : null : children}
    <Pager newer={pager.newer} older={pager.older} texts={texts} />
  </>
);

// A form's anti-forgery token (WEB-4); nothing when the viewer has no session to tie it to.
export const Csrf: FC<{ token: string | null }> = ({ token }) =>
  token === null ? null : <input type="hidden" name="csrf" value={token} />;

type TabItem = { href: string; text: string; current: boolean };

// Sections of a page that are pages of their own: a named nav of links, the current one marked aria-current="page",
// never ARIA tab widgets. A page that is none of them marks none.
export const Tabs: FC<{ label: string; items: TabItem[] }> = ({ label, items }) => (
  <nav class="tabs" aria-label={label}>
    {items.map((item) => (
      <a href={item.href} aria-current={item.current ? "page" : undefined}>
        {item.text}
      </a>
    ))}
  </nav>
);

export type AlertStatus = "ok" | "warn" | "fail";

const ALERT_ICONS: Record<AlertStatus, IconName> = { ok: "check", warn: "cw", fail: "alert" };
// Each status's classes, written out, as every class the stylesheet styles is (test-node/stylesheet.test.ts).
const ALERT_CLASS: Record<AlertStatus, string> = { ok: "alert ok", warn: "alert warn", fail: "alert fail" };

// The one alert (a form's result, a check's outcome, a refused form): the same box for every status, which its bar's
// and icon's colour show, its title in bold and its detail as small text below. A failure is an alert, the others a
// status. A field's own error is not an alert: FieldError, under the field.
export const Alert: FC<{ status: AlertStatus; title: Child; children?: Child }> = ({ status, title, children }) => (
  <div class={ALERT_CLASS[status]} role={status === "fail" ? "alert" : "status"}>
    <Icon name={ALERT_ICONS[status]} size={18} decorative />
    <div class="group">
      <p>
        <strong>{title}</strong>
      </p>
      {children === undefined ? null : <div class="hint group">{children}</div>}
    </div>
  </div>
);

// A field's error, directly under it in the fail colour: its control names it by `id` in aria-describedby and is
// aria-invalid.
export const FieldError: FC<{ id: string; children?: Child }> = ({ id, children }) => (
  <p class="error" id={id} role="alert">
    <Icon name="alert" size={16} decorative />
    <span>{children}</span>
  </p>
);
