import type { Db } from "../../db/sql";
import type { InstanceDocument } from "../../platform/stored-bounds";
import type { Account, Present } from "../accounts";
import { instanceDomainOf } from "../actors";
import { contextOf } from "../auth";
import {
  type AboutSettings,
  aboutSettingsOf,
  contactAccount,
  documentSource,
  documentsOf,
  type InstanceDocumentSource,
} from "../instance";
import { readOperation } from "../operation";
import type { PresentOptions } from "../status-presenter";

// The public pages' reads: one Store call a page. Each read takes no credential, so it cannot see a
// viewer (VIS-4): it reads as the anonymous viewer, and reads the site facts in its own transaction, so the page's
// account, list and footer are one snapshot. Before setup has fixed the domain it answers not_set_up and reads nothing
// else (SETUP-1).

export type SiteDocuments = { privacyPolicy: boolean; termsOfService: boolean };

// What every page shows around its content: the domain and the documents the footer links.
export type Site = { domain: string; documents: SiteDocuments };

export type NotSetUp = { status: "not_set_up" };

// A page read's answer: not_set_up, or the read's own answer with the site facts.
export type PageAnswer<O> = NotSetUp | (O & { site: Site });

function siteOf(db: Db): Site | null {
  const domain = instanceDomainOf(db);
  return domain === null ? null : { domain, documents: documentsOf(db) };
}

// A read of a public page: `run` gets the site facts, and builds the page from them.
export function pageRead<I, O extends object>(run: (db: Db, input: I, site: Site) => O) {
  return readOperation<I, PageAnswer<O>>((db, input) => {
    const site = siteOf(db);
    return site === null ? { status: "not_set_up" } : { ...run(db, input, site), site };
  });
}

// The presentation of a page: URLs on the stored domain, and the anonymous viewer at `now`.
export function anonymous(site: Site, now: number): PresentOptions {
  return { ...pagePresent(site), viewer: contextOf(null, now) };
}

export function pagePresent(site: Site): Present {
  return { origin: `https://${site.domain}` };
}

// The site facts alone: the gate of the pages that read nothing else of the Store (a 404 for a path no page has,
// sign-in and settings), one call as requireSetup is.
export const webSite = pageRead<void, { status: "ok" }>(() => ({ status: "ok" }));

// /about: the settings the about page shows, and the contact account as /api/v2/instance's contact.account presents
// it (an unavailable one redacted, VIS-30); null when none is set or it is not found.
export const webAbout = pageRead<void, { status: "ok"; about: AboutSettings; contact: Account | null }>(
  (db, _input, site) => {
    const about = aboutSettingsOf(db);
    return { status: "ok", about, contact: contactAccount(db, about, pagePresent(site)) };
  },
);

// /privacy-policy and /terms-of-service: the document as stored (the page sanitizes it at its sink, HTML-1), or null
// when it is not available.
export const webDocument = pageRead<
  { name: InstanceDocument },
  { status: "ok"; document: InstanceDocumentSource | null }
>((db, { name }) => ({ status: "ok", document: documentSource(db, name) }));

// `/@alice` or `/@alice@this.domain`; null for another server's account (only local profiles are served).
export function localUsername(handle: string, domain: string): string | null {
  const name = handle.replace(/^@/, "");
  const at = name.indexOf("@");
  if (at === -1) {
    return name;
  }
  return name.slice(at + 1).toLowerCase() === domain ? name.slice(0, at) : null;
}
