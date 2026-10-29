import type { Child, JSXNode } from "hono/jsx";

import { ErrorPage } from "../../src/app/error-pages";
import type { Account, CredentialAccount } from "../../src/domain/accounts";
import { OWNER_ROLE } from "../../src/domain/auth";
import type { Poll } from "../../src/domain/poll-presenter";
import type { MediaAttachment, Status } from "../../src/domain/status-presenter";
import type { Site } from "../../src/domain/web-pages/site";
import type { PageHistory } from "../../src/domain/web-pages/status";
import { embedHtml } from "../../src/mastodon/oembed";
import { APP_NAME_LIMIT, APP_WEBSITE_LIMIT, LOCAL_USERNAME_BYTES } from "../../src/platform/stored-bounds";
import { SCOPES } from "../../src/security/scopes";
import { HostContext, L1Context } from "../../src/web/components/layout";
import { AboutPage } from "../../src/web/pages/about";
import { DocumentPage } from "../../src/web/pages/document";
import { EmbedPage } from "../../src/web/pages/embed";
import { FeaturedPage } from "../../src/web/pages/featured";
import { FollowsPage } from "../../src/web/pages/follows";
import { HandoffFormPage, HandoffPage } from "../../src/web/pages/handoff";
import { InteractionPage, InteractionResultPage } from "../../src/web/pages/interaction";
import { ErrorView } from "../../src/web/pages/message";
import { CodePage, ConsentPage, type ConsentFields } from "../../src/web/pages/oauth";
import { ProfilePage } from "../../src/web/pages/profile";
import { SettingsPage } from "../../src/web/pages/settings";
import { StatusPage } from "../../src/web/pages/status";
import { TagPage } from "../../src/web/pages/tag";
import { ChecklistPage, SetupDonePage, SetupLoginPage, SetupPage } from "../../src/web/setup-pages";
import { STRINGS } from "../../src/web/strings";
import { emojiAllowance } from "../../src/web/view/emoji";
import { accountPreview, accountTarget, statusPreview, statusTarget } from "../../src/web/view/remote";
import { account, CREATED, customEmoji, media, status as post } from "../../test/web-fixtures";
import { DOMAIN, ORIGIN, pageNamed, type PageName } from "../pages";

// Each fixture page of ../pages.ts rendered by the real components from view data, as the Worker renders it
// (src/app/public-pages.tsx). Every image is on the instance origin, so the pages load nothing the job does not serve. This
// module is typed against the Workers types (tsconfig.json here), as the components are.

// A session's anti-forgery token, as the signed-in forms carry it.
const CSRF = "c".repeat(43);

// The consent form's fields, as /oauth/authorize posts them back; and the longest app name (APP_NAME_LIMIT code
// points, unbroken) and website (APP_WEBSITE_LIMIT bytes) an app can register, for the longest local username.
const CONSENT_FIELDS: ConsentFields = {
  client_id: "k".repeat(43),
  redirect_uri: "https://client.example/callback",
  scope: "read write follow",
  state: "s",
};
const LONGEST_APP_NAME = "W".repeat(APP_NAME_LIMIT);
const LONGEST_WEBSITE = `https://client.example/${"p".repeat(APP_WEBSITE_LIMIT - "https://client.example/".length)}`;

// A custom emoji, on the instance origin: a drawn leaf on a transparent ground, padded as a custom emoji's image is,
// which the browser job serves from browser/fixtures/ (it is no product asset).
const LEAF = customEmoji("leaf", `${ORIGIN}/fixtures/leaf.svg`);

// The shared builders (test/web-fixtures.ts), with this job's own values: alice's name, bio, counts, emoji and field.
const alice: Account = account({
  display_name: "Alice :leaf:",
  note: '<p>Writes about <a href="https://kopje.test/tags/walks">#walks</a> and trains.</p>',
  followers_count: 12,
  following_count: 3,
  statuses_count: 4,
  emojis: [LEAF],
  fields: [{ name: "Site", value: '<a href="https://site.example/" rel="me">site.example</a>', verified_at: null }],
});

const image: MediaAttachment = media("50", {
  url: `${ORIGIN}/assets/thumbnail.jpg`,
  preview_url: `${ORIGIN}/assets/thumbnail.jpg`,
  meta: { small: { width: 640, height: 336, size: "640x336", aspect: 640 / 336 } },
  description: "A path through a field",
});

// Media of every other type: a video with its own preview as its poster, a gifv and an audio file without one, and a
// file of another type. The players' files are never served: preload="none" means the page asks for none of them until
// played.
const player = (id: string, type: string, preview: boolean, description: string | null): MediaAttachment => ({
  ...image,
  id,
  type,
  url: `${ORIGIN}/media/${id}/full.bin`,
  preview_url: preview ? `${ORIGIN}/assets/thumbnail.jpg` : `${ORIGIN}/media/${id}/full.bin`,
  description,
});
const players = [
  player("51", "video", true, "A walk along the river"),
  player("52", "gifv", false, "A leaf turning"),
  player("53", "audio", false, null),
  player("55", "audio", false, "Birdsong at dawn"),
  player("54", "unknown", false, "Field notes"),
];

// A poll still open, its counts shown.
const openPoll: Poll = {
  id: "102",
  expires_at: "2026-10-30T12:00:00.000Z",
  expired: false,
  multiple: false,
  votes_count: 12,
  voters_count: 12,
  options: [
    { title: "The river path :leaf:", votes_count: 9 },
    { title: "The hill", votes_count: 3 },
  ],
  emojis: [LEAF],
};

// A post of alice's with this job's counts and content.
function status(id: string, fields: Partial<Status>): Status {
  return post(id, {
    replies_count: 1,
    reblogs_count: 2,
    favourites_count: 3,
    content: "<p>A plain post.</p>",
    account: alice,
    ...fields,
  });
}

const plain = status("101", {});
// Behind its warning, the embed's post holds a poll whose counts are hidden and quotes a post (nested).
const warned = status("104", {
  spoiler_text: "Spoilers for the last chapter",
  sensitive: true,
  content: '<p>The <a href="https://kopje.test/tags/ending">#ending</a> was a surprise.</p>',
  // The status's emojis hold its poll's, as Mastodon's Status#emojis does.
  emojis: [LEAF],
  poll: { ...openPoll, options: openPoll.options.map((option) => ({ ...option, votes_count: null })) },
  quote: { state: "accepted", quoted_status: plain },
});
// The warned post's twin without its warning, which the tag page shows beside it.
const unwarned = status("113", { ...warned, id: "113", spoiler_text: "", sensitive: false });
const sensitiveMedia = status("103", { sensitive: true, content: "<p>A photo.</p>", media_attachments: [image] });
// The status page's post: an emoji, media of every other type (the video first, so its poster is the page's
// likely largest paint), a poll and a quoted post.
const reply = status("102", {
  in_reply_to_id: "101",
  in_reply_to_account_id: "1",
  content: '<p>Replying to myself :leaf: with an <a href="https://site.example/page">outside link</a>.</p>',
  edited_at: "2026-10-21T10:00:00.000Z",
  emojis: [LEAF],
  media_attachments: players,
  poll: openPoll,
  quote: { state: "accepted", quoted_status: { ...plain, quote: null } },
});
// A pinned post (shown before the list on the Posts tab's first page) and a boost of another server's post.
// A pinned post whose quote awaits approval and whose poll has ended.
const pinned = status("106", {
  content: "<p>A pinned post.</p>",
  quote: { state: "pending", quoted_status: null },
  // The status's emojis hold its poll's (Status#emojis), so its choice's :leaf: renders.
  emojis: [LEAF],
  poll: { ...openPoll, expired: true },
});
const bob: Account = {
  ...alice,
  id: "2",
  username: "bob",
  acct: "bob@remote.example",
  display_name: "Bob",
  note: "",
  url: "https://remote.example/@bob",
  uri: "https://remote.example/users/bob",
  fields: [],
};
const boost = status("107", {
  content: "",
  language: null,
  replies_count: 0,
  reblogs_count: 0,
  favourites_count: 0,
  reblog: status("900", {
    account: bob,
    uri: "https://remote.example/users/bob/statuses/900",
    url: "https://remote.example/@bob/900",
    content: "<p>A post from another server.</p>",
  }),
});

// The status page's post's edit history: the current version, an edited one behind its warning with
// sensitive media and a poll's choices, and two older versions left out.
const history: PageHistory = {
  versions: [
    {
      content: reply.content ?? "",
      spoiler_text: "",
      sensitive: false,
      created_at: "2026-10-21T10:00:00.000Z",
      // A choice of 50 characters with no break opportunity, the longest a local poll takes.
      poll: { options: [{ title: "w".repeat(50) }, ...openPoll.options.map(({ title }) => ({ title }))] },
      media_attachments: [],
      emojis: [LEAF],
    },
    {
      content: "<p>Replying to myself :leaf:.</p>",
      spoiler_text: "An earlier warning",
      sensitive: true,
      created_at: "2026-10-20T12:00:00.000Z",
      poll: { options: [{ title: "The river path" }, { title: "The hill :leaf:" }] },
      media_attachments: [image],
      emojis: [LEAF],
    },
  ],
  leftOut: 2,
};

const LONGEST_HOST = ["a", "b", "c"].map((c) => c.repeat(63)).join(".") + `.${"d".repeat(61)}`;

// The thread fixture's post, further down the status page's thread.
const further = status("108", { in_reply_to_id: "102", in_reply_to_account_id: "1", content: "<p>Further down.</p>" });

// alice as the account handoff names her, once for its title and its row.
const aliceTarget = accountTarget(alice, DOMAIN, emojiAllowance());

// The status page's post as the handoff pages name it.
const replyTarget = statusTarget({ uri: reply.uri, url: reply.url ?? "", path: "/@alice/102" });

// The site facts every page read loads (domain/web-pages/site.ts): both documents exist, so every footer links them.
const site: Site = { domain: DOMAIN, documents: { privacyPolicy: true, termsOfService: true } };

// The signed-in account as the settings page reads it: alice with her profile's source.
const credential: CredentialAccount = {
  ...alice,
  source: {
    privacy: "public",
    sensitive: false,
    language: null,
    note: "Writes about #walks and trains.",
    fields: [{ name: "Site", value: "https://site.example/", verified_at: null }],
    follow_requests_count: 0,
    hide_collections: false,
    discoverable: true,
    indexable: true,
    attribution_domains: [],
    quote_policy: "public",
  },
  role: OWNER_ROLE,
};

const ELEMENTS: Record<PageName, Child> = {
  profile: (
    <ProfilePage
      account={alice}
      tab={{ kind: "posts" }}
      pins={[pinned]}
      statuses={[boost, warned, sensitiveMedia, reply, plain]}
      // A post too large to show beside the rest: its row, which the checks cover with the cards.
      stub={{ id: "105", url: `${ORIGIN}/@alice/105`, acct: "alice", created_at: CREATED }}
      parents={{ "101": { url: `${ORIGIN}/@alice/101`, acct: "alice" } }}
      cursor={null}
      paging={{ newest: "107", oldest: "100", more: true }}
      site={site}
      actorUri={alice.uri}
    />
  ),
  // An older page of a hashtag: a stubbed first post, posts and a reply with its parent's line, both pager links.
  tag: (
    <TagPage
      tag="walks"
      statuses={[warned, unwarned, sensitiveMedia, reply, plain]}
      stub={{ id: "105", url: `${ORIGIN}/@alice/105`, acct: "alice", created_at: CREATED }}
      parents={{ "101": { url: `${ORIGIN}/@alice/101`, acct: "alice" } }}
      cursor={{ maxId: "106" }}
      paging={{ newest: "105", oldest: "101", more: true }}
      site={site}
    />
  ),
  // The status page: its parent above it, and a Replies tab with no replies.
  status: (
    <StatusPage
      status={reply}
      parent={{ url: `${ORIGIN}/@alice/101`, acct: "alice" }}
      history={history}
      site={site}
      embed={embedHtml(reply, DOMAIN)}
      thread={{
        ancestors: [plain],
        list: { kind: "replies", statuses: [], stub: null },
        paging: { newest: null, oldest: null, more: false },
        cursor: null,
      }}
    />
  ),
  // A thread at a later page of its replies: two ancestors, then the post, then its replies after a
  // cursor, the first too large to show (a remote one's stub), and both pager links.
  thread: (
    <StatusPage
      status={further}
      parent={{ url: `${ORIGIN}/@alice/102`, acct: "alice" }}
      history={null}
      site={site}
      embed={embedHtml(further, DOMAIN)}
      thread={{
        ancestors: [plain, reply],
        list: {
          kind: "replies",
          statuses: [sensitiveMedia, pinned],
          stub: { id: "109", url: "https://remote.example/@bob/109", acct: "bob@remote.example", created_at: CREATED },
        },
        paging: { newest: "110", oldest: "109", more: true },
        cursor: { minId: "108" },
      }}
    />
  ),
  // A later page of a post's Boosts tab: two accounts (one on another server) and both pager links.
  boosts: (
    <StatusPage
      status={plain}
      parent={null}
      history={null}
      site={site}
      embed={embedHtml(plain, DOMAIN)}
      thread={{
        ancestors: [],
        list: {
          kind: "reblogs",
          accounts: [
            bob,
            { ...alice, id: "3", username: "dana", acct: "dana", display_name: "Dana", url: `${ORIGIN}/@dana` },
          ],
        },
        paging: { newest: "30", oldest: "20", more: true },
        cursor: { maxId: "40" },
      }}
    />
  ),
  // A post's Quotes tab: a quote too large to show (its stub), a quote replying to the post, and one with a
  // warning, each nesting the post; the older pager link only.
  quotes: (
    <StatusPage
      status={{ ...plain, quotes_count: 3 }}
      parent={null}
      history={null}
      site={site}
      embed={embedHtml(plain, DOMAIN)}
      thread={{
        ancestors: [],
        list: {
          kind: "quotes",
          statuses: [
            status("111", {
              in_reply_to_id: "101",
              in_reply_to_account_id: "1",
              content: "<p>Quoting and replying.</p>",
              quote: { state: "accepted", quoted_status: { ...plain, quote: null } },
            }),
            status("110", {
              spoiler_text: "A quote behind a warning",
              content: "<p>Quoting.</p>",
              quote: { state: "accepted", quoted_status: { ...plain, quote: null } },
            }),
          ],
          stub: { id: "112", url: `${ORIGIN}/@alice/112`, acct: "alice", created_at: CREATED },
          parents: { "101": { url: `${ORIGIN}/@alice/101`, acct: "alice" } },
        },
        paging: { newest: "112", oldest: "110", more: true },
        cursor: null,
      }}
    />
  ),
  about: (
    <AboutPage
      title="Kopje Test"
      site={site}
      description="A small server for testing."
      contactEmail="admin@kopje.test"
      contact={alice}
      software={{ version: "1.0.0", repository: "https://github.com/shuymn/kopje" }}
      rules={[
        { id: "1", text: "Be kind.", hint: "", translations: {} },
        { id: "2", text: "No spam.", hint: "Advertising included.", translations: {} },
      ]}
      // Inline content directly in the body, not in a <p>: text, a link and text share one line box.
      extendedDescription={
        'Run by <a href="https://kopje.test/@alice">one person</a> alone.<p>See the <a href="https://kopje.test/privacy-policy">policy</a>.</p>'
      }
    />
  ),
  // An operator's policy as it renders: paragraphs and a section heading.
  document: (
    <DocumentPage
      title={STRINGS.documents.privacyPolicy}
      site={site}
      path="/privacy-policy"
      html='<p>We keep <a href="https://kopje.test/about">little data</a> about you.</p><h2>Logs</h2><p>Kept for a week.</p>'
      updatedAt="2026-10-01T00:00:00.000Z"
      effectiveDate={null}
    />
  ),
  // An older page of a follow list, its last: a member on another server (its link names the server) and one of this
  // server's, the newer page linked and no older one.
  followers: (
    <FollowsPage
      account={alice}
      direction="followers"
      hidden={false}
      accounts={[
        bob,
        { ...alice, id: "3", username: "dana", acct: "dana", display_name: "Dana", url: `${ORIGIN}/@dana` },
      ]}
      cursor={{ maxId: "40" }}
      paging={{ newest: "30", oldest: "20", more: false }}
      site={site}
    />
  ),
  // An account that hides its network: the counts alone.
  "follows-hidden": (
    <FollowsPage
      account={{ ...alice, id: "4", username: "carol", acct: "carol", display_name: "Carol", url: `${ORIGIN}/@carol` }}
      direction="following"
      hidden
      accounts={[]}
      cursor={null}
      paging={{ newest: null, oldest: null, more: false }}
      site={site}
    />
  ),
  // The Featured tab: a hashtag with its page, an imported name that has none, two endorsed accounts (one on another
  // server) and a page past them.
  featured: (
    <FeaturedPage
      account={alice}
      tags={[
        {
          featured: {
            id: "1",
            name: "Walks",
            url: `${ORIGIN}/@alice/tagged/walks`,
            statuses_count: "12",
            last_status_at: "2026-10-20",
          },
          tag: "walks",
        },
        {
          featured: {
            id: "2",
            name: "a-b",
            url: `${ORIGIN}/@alice/tagged/ab`,
            statuses_count: "1",
            last_status_at: null,
          },
          tag: null,
        },
      ]}
      accounts={[
        bob,
        { ...alice, id: "3", username: "dana", acct: "dana", display_name: "Dana", url: `${ORIGIN}/@dana` },
      ]}
      cursor={null}
      paging={{ newest: "3", oldest: "2", more: true }}
      site={site}
    />
  ),
  "not-found": <ErrorView chrome={site} status={404} />,
  embed: <EmbedPage status={warned} domain={DOMAIN} />,
  interaction: <InteractionPage site={site} uri={alice.uri} csrf={CSRF} />,
  "interaction-result": (
    <InteractionResultPage site={site} target={{ kind: "account", account: alice }} uri={alice.uri} csrf={CSRF} />
  ),
  "interaction-post": (
    <InteractionResultPage
      site={site}
      target={{
        kind: "status",
        status: status("120", {
          account: { ...alice, display_name: "W".repeat(30), emojis: [] },
          content: "<p>A post found by its URL.</p>",
        }),
      }}
      uri={`${ORIGIN}/@alice/120`}
      csrf={CSRF}
    />
  ),
  "handoff-form": (
    <HandoffFormPage site={site} target={accountTarget(alice, DOMAIN, emojiAllowance())} problem={false} />
  ),
  "handoff-refused": <HandoffFormPage site={site} target={replyTarget} problem />,
  // Its post's text runs past the two lines the page shows of it.
  handoff: (
    <HandoffPage
      site={site}
      target={replyTarget}
      preview={statusPreview(
        {
          ...reply,
          content: `<p>Replying to myself :leaf: ${"about the walk along the river and the trains on the bridge, ".repeat(6)}</p>`,
        },
        DOMAIN,
        emojiAllowance(),
      )}
      host="social.example"
    />
  ),
  // The longest host accepted (253 octets, labels of 63), which the page's heading and link must wrap at 320 px.
  "handoff-long": (
    <HandoffPage
      site={site}
      target={aliceTarget}
      preview={accountPreview(alice, DOMAIN, aliceTarget)}
      host={LONGEST_HOST}
    />
  ),
  // Settings after a save: the notice, two authorized apps (the second with a long name and every scope) and other
  // sessions to sign out.
  settings: (
    <SettingsPage
      chrome={site}
      account={credential}
      authorizations={{
        apps: [
          {
            clientId: "client-1",
            name: "A client",
            website: "https://client.example/",
            scopes: ["read", "write"],
            authorizedAt: CREATED,
          },
          {
            clientId: "client-2",
            name: "An application with a remarkably long name for its authorized row",
            website: null,
            scopes: [...SCOPES],
            authorizedAt: CREATED,
          },
        ],
        otherSessions: 2,
      }}
      csrf={CSRF}
      notice="saved"
      problems={[]}
    />
  ),
  "setup-login": <SetupLoginPage problem="The setup session ended. Enter the setup token again." />,
  // The wizard with the domain confirmed and Access ready: a passed step, a warning with its hint and a failure.
  setup: (
    <SetupPage
      mode="setup"
      host={DOMAIN}
      hostProblem={null}
      csrf={CSRF}
      view={{
        bootstrapped: false,
        authorized: true,
        draft: {
          domain: DOMAIN,
          access: {
            teamDomain: "team",
            accountId: "0".repeat(32),
            signInAud: "a".repeat(64),
            adminAud: "b".repeat(64),
            adminEmail: "admin@kopje.test",
            serviceTokenClientId: null,
          },
          accessRevision: 1,
          accessReady: true,
        },
        config: null,
        access: { state: "completed", completedAt: Date.parse(CREATED), lateFailureAt: null },
        probe: null,
        images: null,
        cronLastRun: null,
      }}
      results={{ domain: { status: "pass", text: `Using ${DOMAIN}.` } }}
      queue={{ status: "warn", text: "No probe has been sent.", hint: "Send one, then reload." }}
      cron={{ status: "fail", text: "The cron trigger has not run." }}
      images={undefined}
      accessState={{ status: "pass", text: "Both Access applications are in place." }}
    />
  ),
  "setup-checklist": <ChecklistPage />,
  "setup-done": <SetupDonePage />,
  consent: (
    <ConsentPage
      appName="Test Client"
      website="https://client.example"
      username="alice"
      domain={DOMAIN}
      scopes={["read", "write", "follow"]}
      fields={CONSENT_FIELDS}
    />
  ),
  "consent-long": (
    <ConsentPage
      appName={LONGEST_APP_NAME}
      website={LONGEST_WEBSITE}
      username={"a".repeat(LOCAL_USERNAME_BYTES)}
      domain={DOMAIN}
      scopes={[...SCOPES]}
      fields={{ ...CONSENT_FIELDS, scope: SCOPES.join(" ") }}
    />
  ),
  "consent-first-party": (
    <ConsentPage
      appName="Kopje"
      website={null}
      username="alice"
      domain={DOMAIN}
      scopes={["read"]}
      fields={CONSENT_FIELDS}
      firstParty
    />
  ),
  // An authorization code as deps.randomToken makes it, 43 characters of base64url, here without a '-' to break at.
  code: <CodePage code={"Qz9".repeat(14) + "Q"} />,
  "error-404": <ErrorPage status={404} />,
  "error-500": <ErrorPage status={500} />,
  "error-503": <ErrorPage status={503} />,
};

// The bytes the Worker sends for each page: c.html writes the rendered element as it is, inside L1Context on the
// pages that load the L1 bundle (l1Page in src/app/public-pages.tsx), and in HostContext with the request's host, which
// the routes of the pages without the site's chrome set (onHost) and no other page reads.
export async function renderPages(): Promise<Record<PageName, string>> {
  const html = {} as Record<PageName, string>;
  for (const [name, element] of Object.entries(ELEMENTS) as [PageName, Child][]) {
    const l1 =
      pageNamed(name).kind === "l1" ? <L1Context.Provider value={true}>{element}</L1Context.Provider> : element;
    const page = <HostContext.Provider value={DOMAIN}>{l1}</HostContext.Provider>;
    // hono's async render returns a String object (raw()) typed as string; String() makes it the primitive the tests
    // compare and search.
    // oxlint-disable-next-line typescript/no-unnecessary-type-conversion
    html[name] = String(await (page as Child as JSXNode).toString());
  }
  return html;
}
