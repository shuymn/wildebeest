import type { FC } from "hono/jsx";

import type { Status } from "../../domain/status-presenter";
import type { StatusStub } from "../../domain/web-pages/budget";
import type { PageCursor } from "../../domain/web-pages/paging";
import type { ParentLink } from "../../domain/web-pages/parents";
import type { Site } from "../../domain/web-pages/site";
import type { PageHistory, StatusTabKind, Thread } from "../../domain/web-pages/status";
import { AccountFeed } from "../components/accounts";
import { type PagerTexts, Tabs } from "../components/basics";
import { ActionsMenu, DialogOpener } from "../components/dialog";
import { HISTORY_DIALOG, HistoryDialog } from "../components/history";
import { Icon } from "../components/icon";
import { Layout } from "../components/layout";
import { PostCard, PostFeed, PostStub, ThreadUp } from "../components/post";
import { EMBED_DIALOG, EmbedDialog, INTERACT_DIALOG, RemoteDialog } from "../components/remote";
import { statusSummary } from "../safe-html";
import { useUi } from "../ui";
import { address, authorView, displayName } from "../view/account";
import { type EmojiAllowance, emojiAllowance } from "../view/emoji";
import { historyView } from "../view/history";
import { shownImage } from "../view/media";
import { newestFirstPager, type PagerLinks, repliesPager } from "../view/pager";
import { type CountKind, likelyLcp, postView, stubView } from "../view/post";
import { statusTarget } from "../view/remote";

// `thread`: the status's thread and its tab at the request's cursor. `embed`: the status's embed code,
// the oEmbed html (mastodon/oembed.ts embedHtml).
export type StatusView = {
  status: Status;
  parent: ParentLink | null;
  history: PageHistory | null;
  site: Site;
  thread?: Thread & { cursor: PageCursor };
  embed: string;
};

// The tabs in the order the page shows them, and the count each is named by.
// The id of the focal post's menu of further actions.
const ACTIONS_MENU = "actions";

const STATUS_TABS: readonly { kind: StatusTabKind; count: CountKind }[] = [
  { kind: "replies", count: "replies" },
  { kind: "reblogs", count: "boosts" },
  { kind: "favourites", count: "favourites" },
  { kind: "quotes", count: "quotes" },
];

// The cursor-less path of a status's tab: the Replies tab is the status's own path, under its author's
// stored username; the others are below it.
function statusTabPath(status: Status, kind: StatusTabKind): string {
  const base = `/@${status.account.username}/${status.id}`;
  return kind === "replies" ? base : `${base}/${kind}`;
}

// /@username/:id and its tabs: the status, with the author's name as the page's h1 and the parent it replies to when
// the anonymous viewer may see it; above it its ancestors (ThreadUp), below it its tabs and the current tab's list,
// paged both ways; its counts link to their tabs. The page's likely largest paint is the post's first attachment when
// nothing covers it: an image is loaded first by its own element (MediaGrid), and a video's or gifv's poster, when it
// has a real one, by a preload in the head; either is the page's one high-priority request. An edited status with
// recorded versions has its history in a dialog after the post, which the post's "Edited" opens, and the post opens two
// more: to open it on the viewer's server, and its embed code. The head names the status's oEmbed as Mastodon's status
// page does (statuses/show.html.haml: api_oembed_url with the status page's URL and format json).
export const StatusPage: FC<StatusView> = ({ status, parent, history, site, thread, embed }) => {
  const { m } = useUi();
  const { domain } = site;
  const author = status.account;
  const title = m.profile.title(displayName(author), address(author, domain));
  // Bounded as a description, the warning as the content: the page holds it twice more in its head.
  const description = statusSummary(status);
  // The page's emoji allowance, the status first, then the rest in document order: its ancestors, its
  // history dialog and its tab's list.
  const allowance = emojiAllowance();
  // Its counts link to its tabs (postView, as every post of this server's).
  const post = postView(status, parent, domain, allowance);
  const ancestors = (thread?.ancestors ?? []).map((ancestor) => postView(ancestor, null, domain, allowance));
  const versions = history === null || status.edited_at === null ? null : historyView(history, domain, allowance);
  const first = post.media[0];
  const image = status.sensitive || first === undefined ? null : shownImage(first);
  const lcp = likelyLcp(post);
  const poster = lcp !== null && (lcp.kind === "video" || lcp.kind === "gifv") ? lcp.preview : null;
  const kind = thread?.list.kind ?? "replies";
  // A tab page with a cursor names its cursor-less page as canonical, and is not indexed.
  const canonical = kind === "replies" ? (status.url ?? undefined) : `https://${domain}${statusTabPath(status, kind)}`;
  const remote =
    status.url === null
      ? null
      : statusTarget({ uri: status.uri, url: status.url, path: `/@${author.username}/${status.id}` });
  return (
    <Layout
      title={title}
      chrome={site}
      head={
        <>
          <meta name="description" content={description} />
          {thread === undefined || thread.cursor === null ? null : <meta name="robots" content="noindex, follow" />}
          <meta property="og:site_name" content={domain} />
          <meta property="og:type" content="article" />
          <meta property="og:title" content={title} />
          <meta property="og:description" content={description} />
          <meta property="og:url" content={status.url ?? undefined} />
          {image === null ? null : <meta property="og:image" content={image} />}
          {poster === null ? null : <link rel="preload" as="image" href={poster} fetchpriority="high" />}
          <meta property="article:published_time" content={status.created_at} />
          <link rel="canonical" href={canonical} />
          {status.url === null ? null : (
            <link
              rel="alternate"
              type="application/json+oembed"
              href={`https://${domain}/api/oembed?format=json&url=${encodeURIComponent(status.url)}`}
            />
          )}
          <link rel="alternate" type="application/activity+json" href={status.uri} />
        </>
      }
    >
      <ThreadUp posts={ancestors} />
      <PostCard
        post={post}
        variant="focal"
        history={versions === null ? undefined : HISTORY_DIALOG}
        actions={[
          <ActionsMenu id={ACTIONS_MENU}>
            {remote === null ? null : (
              <DialogOpener dialog={INTERACT_DIALOG} class="btn quiet">
                <Icon name="ext" size={18} decorative />
                {m.remote.openOnYourServer}
              </DialogOpener>
            )}
            <DialogOpener dialog={EMBED_DIALOG} class="btn quiet">
              <Icon name="code" size={18} decorative />
              {m.embed.embed}
            </DialogOpener>
          </ActionsMenu>,
        ]}
      />
      {versions === null ? null : <HistoryDialog history={versions} />}
      {remote === null ? null : <RemoteDialog id={INTERACT_DIALOG} target={remote} />}
      <EmbedDialog code={embed} />
      {thread === undefined ? null : (
        <TabSection status={status} thread={thread} domain={domain} allowance={allowance} />
      )}
    </Layout>
  );
};

// The status page's tabs, each named by its count, and the current tab's list on its page.
const TabSection: FC<{
  status: Status;
  thread: Thread & { cursor: PageCursor };
  domain: string;
  allowance: EmojiAllowance;
}> = ({ status, thread, domain, allowance }) => {
  const { m } = useUi();
  const { list, cursor, paging } = thread;
  const counts: Record<CountKind, number> = {
    replies: status.replies_count,
    boosts: status.reblogs_count,
    favourites: status.favourites_count,
    quotes: status.quotes_count,
  };
  const tabs = (
    <Tabs
      label={m.a11y.statusSections}
      items={STATUS_TABS.map((tab) => ({
        href: statusTabPath(status, tab.kind),
        text: m.counts[tab.count](counts[tab.count]),
        current: tab.kind === list.kind,
      }))}
    />
  );
  const base = statusTabPath(status, list.kind);
  switch (list.kind) {
    case "replies": {
      const pager = repliesPager(base, cursor, paging);
      return (
        <>
          {tabs}
          <StatusFeed
            statuses={list.statuses}
            stub={list.stub}
            parentOf={() => null}
            // Replies counted but none shown are on other servers, which this page does not list.
            emptyText={status.replies_count > 0 ? m.post.remoteReplies : m.post.noReplies}
            pager={{ newer: pager.earlier, older: pager.later }}
            texts={{
              newer: m.pager.earlierReplies,
              older: m.pager.laterReplies,
              newerShort: m.pager.earlierShort,
              olderShort: m.pager.laterShort,
            }}
            domain={domain}
            allowance={allowance}
          />
        </>
      );
    }
    case "quotes": {
      const { parents } = list;
      return (
        <>
          {tabs}
          <StatusFeed
            statuses={list.statuses}
            stub={list.stub}
            parentOf={(quote) => (quote.in_reply_to_id === null ? null : (parents[quote.in_reply_to_id] ?? null))}
            emptyText={m.post.noQuotes}
            pager={newestFirstPager(base, cursor, paging)}
            quotesPage
            domain={domain}
            allowance={allowance}
          />
        </>
      );
    }
    case "reblogs":
    case "favourites":
      return (
        <>
          {tabs}
          <AccountFeed
            accounts={list.accounts.map((account) => authorView(account, domain, allowance))}
            emptyText={list.kind === "reblogs" ? m.post.noBoosts : m.post.noFavourites}
            pager={newestFirstPager(base, cursor, paging)}
          />
        </>
      );
  }
};

// A tab's list of statuses (its replies or quotes) on its page: the stub of a first that did not fit, then the cards,
// each with the reply-to line of its parent link (`parentOf`), then the pager (PostFeed).
const StatusFeed: FC<{
  statuses: Status[];
  stub: StatusStub | null;
  parentOf: (status: Status) => ParentLink | null;
  emptyText: string;
  pager: PagerLinks;
  texts?: PagerTexts;
  domain: string;
  allowance: EmojiAllowance;
  quotesPage?: boolean;
}> = ({ statuses, stub, parentOf, emptyText, pager, texts, domain, allowance, quotesPage = false }) => (
  <PostFeed empty={statuses.length === 0 && stub === null} emptyText={emptyText} pager={pager} texts={texts}>
    {stub === null ? null : (
      <li>
        <PostStub stub={stubView(stub, domain)} />
      </li>
    )}
    {statuses.map((status) => (
      <li>
        <PostCard post={postView(status, parentOf(status), domain, allowance)} variant="feed" quotesPage={quotesPage} />
      </li>
    ))}
  </PostFeed>
);
