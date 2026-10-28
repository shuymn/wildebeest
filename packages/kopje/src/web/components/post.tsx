import type { Child, FC } from "hono/jsx";

import type { IconName } from "../icons";
import { useUi } from "../ui";
import type { AuthorView } from "../view/account";
import type { EmojiRef, Inline } from "../view/emoji";
import type { Link } from "../view/link";
import type { MediaView } from "../view/media";
import type { PagerLinks } from "../view/pager";
import type { PollOptionView, PollView } from "../view/poll";
import type { CountKind, CountView, PostView, QuoteView, StubView } from "../view/post";
import { DateTime, LinkTo, PagedList, type PagerTexts, Rich, VisuallyHidden } from "./basics";
import { DialogOpener } from "./dialog";
import { usePageId } from "./html";
import { Icon } from "./icon";

// Accounts and posts. Avatars are decorative; their boxes match their CSS size.

type AvatarSize = 40 | 44 | 88;

// Each size's class, written out so every class the stylesheet styles is a literal in the source (stylesheet test).
const AVATAR_CLASS: Record<AvatarSize, string> = { 40: "av av40", 44: "av av44", 88: "av av88" };

export const Avatar: FC<{ src: string | null; size: AvatarSize; eager?: boolean }> = ({ src, size, eager = false }) =>
  src === null ? (
    <span class={AVATAR_CLASS[size]} aria-hidden="true" />
  ) : (
    <img
      class={AVATAR_CLASS[size]}
      src={src}
      alt=""
      width={size}
      height={size}
      loading={eager ? undefined : "lazy"}
      decoding="async"
    />
  );

// A custom emoji: its shortcode as its text, at the 20 px its box takes. Its markup is emojiHtml's, which the
// allowance charges (view/emoji.ts).
export const Emoji: FC<{ emoji: EmojiRef }> = ({ emoji }) => (
  <img
    class="emoji"
    src={emoji.url}
    alt={`:${emoji.shortcode}:`}
    width={20}
    height={20}
    loading="lazy"
    decoding="async"
  />
);

export const InlineText: FC<{ text: Inline[] }> = ({ text }) => (
  <>{text.map((part) => (typeof part === "string" ? part : <Emoji emoji={part} />))}</>
);

// An account's name, address and, for a post, its date (a link to the post when it has one). `action`: a control at
// the row's end (the look-up result's Follow, as the profile card has it beside the avatar).
export const Who: FC<{
  account: AuthorView;
  size: 40 | 44;
  heading?: "h1" | undefined;
  when?: { iso: string; text: string; link: Link | null; edited: boolean } | undefined;
  action?: Child;
}> = ({ account, size, heading, when, action }) => {
  const { m } = useUi();
  // An account records no language: its name is in an unknown one (lang=""), not the page's.
  const name = (
    <span lang="">
      <InlineText text={account.name} />
    </span>
  );
  // A post's time of day matters: on a page without the L1 bundle (the embed, the interaction page) it stays the full
  // UTC instant (DateTime), as do the focal date and a poll's end, rather than a calendar date.
  const date = when === undefined ? null : <DateTime iso={when.iso} text={when.text} local />;
  return (
    <div class="who">
      {/* The focal post's author avatar is above the fold: eager. */}
      <Avatar src={account.avatar} size={size} eager={heading === "h1"} />
      <div class="id">
        {heading === "h1" ? (
          <h1 class="name">
            {account.link === null ? (
              name
            ) : (
              <LinkTo class="quiet-link" link={account.link}>
                {name}
              </LinkTo>
            )}
          </h1>
        ) : account.link === null ? (
          <span class="name">{name}</span>
        ) : (
          <LinkTo class="name quiet-link" link={account.link}>
            {name}
          </LinkTo>
        )}
        <p class="meta">
          <span class="handle">{account.address}</span>
          {when === undefined ? null : (
            <span>
              {when.link === null ? (
                date
              ) : (
                <LinkTo class="quiet-link" link={when.link}>
                  {date}
                </LinkTo>
              )}
            </span>
          )}
          {when?.edited === true ? <span>{m.post.edited}</span> : null}
        </p>
      </div>
      {action === undefined ? null : <div class="end">{action}</div>}
    </div>
  );
};

// The state cue of a summary: Show while closed, Hide while open (the stylesheet hides the other).
export const Disclosure: FC = () => {
  const { m } = useUi();
  return (
    <>
      <span class="show">{m.post.show}</span>
      <span class="hide">{m.post.hide}</span>
    </>
  );
};

export const ContentWarning: FC<{ text: Inline[]; lang: string; children?: Child }> = ({ text, lang, children }) => {
  return (
    <details class="cw">
      <summary>
        <span class="spoiler" lang={lang}>
          <Icon name="cw" size={18} decorative />
          <InlineText text={text} />
        </span>
        <Disclosure />
      </summary>
      {/* The revealed content, spaced as the post's own blocks are (a details element's content is one box). */}
      <div class="stack">{children}</div>
    </details>
  );
};

// The media of a post by type. `lcp`: its first image is the page's likely largest paint, loaded first; every other
// image is lazy. Video and audio load nothing before the reader plays them (preload="none", no autoplay); a video's
// poster is its own preview only, and a gifv loops muted with its controls. `playback` false (a page whose CSP allows
// no media) shows video and audio as links instead.
// `lang`: the post's language ('' unknown), which the descriptions are written in.
export const MediaGrid: FC<{
  items: MediaView[];
  sensitive: boolean;
  lcp: boolean;
  playback: boolean;
  lang: string;
}> = ({ items, sensitive, lcp, playback, lang }) => {
  const { m } = useUi();
  if (items.length === 0) {
    return null;
  }
  const nextId = usePageId("alt");
  // A described attachment's ALT badge: a button that opens the description in a popover (light dismiss, no script).
  // The description is text, escaped by the renderer. `id`: the popover's, which a player is named by
  // (aria-labelledby), so its description is on the page once; an image's is its alt too (charged by the page's read,
  // altCopyBytes).
  const altBadge = (item: MediaView, id: string | undefined) => {
    // No badge without a description (mediaView counts one of only white space as none).
    if (id === undefined) {
      return null;
    }
    return (
      <>
        {/* Named by its visible label first, then what it does (WCAG 2.5.3, label in name). */}
        <button type="button" class="alt" popovertarget={id}>
          {m.media.alt}
          <VisuallyHidden>{m.media.showDescription}</VisuallyHidden>
        </button>
        <p id={id} popover="auto" class="alt-text card" lang={lang}>
          {item.alt}
        </p>
      </>
    );
  };
  const grid = (
    <div class="media-grid">
      {items.map((item, index) => {
        const first = lcp && !sensitive && index === 0;
        const box = item.width === undefined ? "box" : undefined;
        const id = item.alt === "" ? undefined : nextId();
        if (item.kind === "image") {
          return (
            <div class="media-item image">
              <a href={item.full}>
                <img
                  class={box}
                  lang={lang}
                  src={item.preview ?? item.full}
                  alt={item.alt}
                  width={item.width}
                  height={item.height}
                  loading={first ? undefined : "lazy"}
                  fetchpriority={first ? "high" : undefined}
                  decoding="async"
                />
                {/* A missing description shows nothing (as Mastodon's); the link is still named. */}
                {item.alt === "" ? <VisuallyHidden>{m.media.attachment}</VisuallyHidden> : null}
              </a>
              {altBadge(item, id)}
            </div>
          );
        }
        if (playback && (item.kind === "video" || item.kind === "gifv")) {
          const gifv = item.kind === "gifv";
          return (
            <div class="media-item wide video">
              <video
                class={box}
                src={item.full}
                poster={item.preview ?? undefined}
                width={item.width}
                height={item.height}
                controls
                playsinline
                preload="none"
                muted={gifv}
                loop={gifv}
                aria-labelledby={id}
              />
              {altBadge(item, id)}
            </div>
          );
        }
        if (playback && item.kind === "audio") {
          return (
            <div class="media-item wide audio">
              {/* The badge's slot above the player, kept without one, so every player is full width and in line. */}
              <div class="alt-slot">{altBadge(item, id)}</div>
              <audio src={item.full} controls preload="none" aria-labelledby={id} />
            </div>
          );
        }
        return item.link === null ? null : (
          <LinkTo class="media-file" link={item.link}>
            <Icon name="file" size={18} decorative />
            {item.alt === "" ? m.media.attachment : <span lang={lang}>{item.alt}</span>}
          </LinkTo>
        );
      })}
    </div>
  );
  return sensitive ? (
    <details class="sensitive">
      <summary>
        <span class="spoiler">
          <Icon name="media" size={18} decorative />
          {m.post.sensitiveMedia}
        </span>
        <Disclosure />
      </summary>
      {grid}
    </details>
  ) : (
    grid
  );
};

// A poll's choices: one outlined row each, the same box in every state (kopje.css). Once the counts are shown, a row
// holds its share as text at its end and as an SVG rect behind its text, the leading choice's in the accent's tint;
// without shares (counts hidden, or an edit-history version, which records none) the row is the text alone. The
// status's poll and its edit history both draw them here. No inline style: the fill's width is the rect's attribute.
export const PollOptions: FC<{ options: PollOptionView[]; lang: string }> = ({ options, lang }) => {
  const { f } = useUi();
  return (
    <ul class="opts" role="list">
      {options.map((option) => (
        <li>
          {option.share === null ? null : (
            <svg class="fill" aria-hidden="true" focusable="false">
              <rect
                class={option.share.leading ? "leading" : undefined}
                width={`${Math.round(option.share.ratio * 1000) / 10}%`}
                height="100%"
              />
            </svg>
          )}
          <span lang={lang}>
            <InlineText text={option.title} />
          </span>
          {option.share === null ? null : <span class="share">{f.percent(option.share.ratio)}</span>}
        </li>
      ))}
    </ul>
  );
};

// A poll (POLL-2): its choices, then how many took part and when it ends or that it has; an open poll whose
// counts are hidden says when they appear.
const Poll: FC<{ poll: PollView; lang: string }> = ({ poll, lang }) => {
  const { m, f } = useUi();
  return (
    <div class="poll">
      <PollOptions options={poll.options} lang={lang} />
      <p class="meta">
        <span>
          <Icon name="poll" size={16} decorative />
          {poll.turnout.voters ? m.poll.people(poll.turnout.n) : m.poll.votes(poll.turnout.n)}
        </span>
        {poll.expired ? (
          <span>{m.poll.closed}</span>
        ) : poll.expiresAt === null ? null : (
          <span>
            {m.poll.ends} <DateTime iso={poll.expiresAt} text={f.instant(poll.expiresAt)} local="deadline" />
          </span>
        )}
      </p>
      {poll.expired || poll.options.some((option) => option.share !== null) ? null : (
        <p class="hint">{m.poll.resultsLater}</p>
      )}
    </div>
  );
};

// The post a post quotes: nested, with its author, date, content, media and poll, or its state as text
// (R35: the presenter embeds only a post the viewer may see by itself). `ofPage`: the quote is of the page's own post
// (its Quotes tab), named in one line rather than nested again.
const Quote: FC<{ quote: QuoteView; playback: boolean; ofPage?: boolean }> = ({ quote, playback, ofPage = false }) => {
  const { m, f } = useUi();
  if (ofPage && quote.state === "accepted") {
    return (
      <p class="label">
        <Icon name="quote" size={16} decorative />
        {m.post.quotingThis}
      </p>
    );
  }
  if (quote.state !== "accepted") {
    return (
      <p class="gone">
        <Icon name="quote" size={16} decorative />
        {m.quote[quote.state]}
      </p>
    );
  }
  const { post } = quote;
  return (
    <div class="quote">
      <Who
        account={post.author}
        size={40}
        when={{ iso: post.createdAt, text: f.instant(post.createdAt), link: post.link, edited: post.editedAt !== null }}
      />
      <PostBody post={post} lcp={false} playback={playback} />
    </div>
  );
};

// A quoting post's content hides its fallback line (`RE: <link>`, class quote-inline), as clients that show the quote
// do.
const PostBody: FC<{ post: PostView; lcp: boolean; playback: boolean; quotesPage?: boolean }> = ({
  post,
  lcp,
  playback,
  quotesPage = false,
}) => {
  const content = (
    <>
      <Rich class={post.quote === null ? "body" : "body quoting"} html={post.html} lang={post.lang} />
      <MediaGrid
        items={post.media}
        sensitive={post.sensitive}
        lcp={lcp && post.cw.length === 0}
        playback={playback}
        lang={post.lang}
      />
      {post.poll === null ? null : <Poll poll={post.poll} lang={post.lang} />}
      {post.quote === null ? null : <Quote quote={post.quote} playback={playback} ofPage={quotesPage} />}
    </>
  );
  // The content warning hides the content until the reader opens it, with no script.
  return post.cw.length === 0 ? (
    content
  ) : (
    <ContentWarning text={post.cw} lang={post.lang}>
      {content}
    </ContentWarning>
  );
};

const COUNT_ICONS: Record<CountKind, IconName> = {
  replies: "reply",
  boosts: "boost",
  favourites: "fav",
  quotes: "quote",
};

// A linked count is named by its label, which contains the visible number; an unlinked one shows the number to sight
// and the label to assistive technology.
// `actions`: controls after the counts, at the row's end (the focal post's dialogs on the status page).
const Counts: FC<{ items: CountView[]; actions?: Child[] }> = ({ items, actions = [] }) => {
  const { m, f } = useUi();
  return (
    <div class="counts">
      {items.map((item) => {
        const label = m.counts[item.kind](item.n);
        const icon = <Icon name={COUNT_ICONS[item.kind]} size={16} decorative />;
        return item.href === undefined ? (
          <span>
            {icon}
            <span aria-hidden="true">{f.count(item.n)}</span>
            <VisuallyHidden>{label}</VisuallyHidden>
          </span>
        ) : (
          <a href={item.href} aria-label={label}>
            {icon}
            {f.count(item.n)}
          </a>
        );
      })}
      {actions.length === 0 ? null : <span class="acts">{actions}</span>}
    </div>
  );
};

// `playback`: whether the page's CSP lets media play (media-src); every public page's and the embed's does.
// `history`: the id of the page's edit-history dialog, which the focal post's "Edited" opens; without
// one, "Edited" is text. `actions`: the focal post's further controls, after its counts (the status page's dialogs).
// `action`: a control by the author, at the end of Who's row (the look-up result's Follow). `quotesPage`: a card of a
// post's Quotes tab, whose quote of that post is named in one line.
export const PostCard: FC<{
  post: PostView;
  variant: "feed" | "focal" | "embed";
  label?: { icon: IconName; text: Child } | undefined;
  playback?: boolean;
  history?: string | undefined;
  actions?: Child[];
  action?: Child;
  quotesPage?: boolean;
}> = ({ post, variant, label, playback = true, history, actions = [], action, quotesPage = false }) => {
  const { m, f } = useUi();
  const focal = variant === "focal";
  const edited = post.editedAt !== null;
  return (
    <article class={focal ? "card post focal" : "card post"}>
      {label === undefined ? null : (
        <p class="label">
          <Icon name={label.icon} size={16} decorative />
          {label.text}
        </p>
      )}
      <Who
        account={post.author}
        size={44}
        heading={focal ? "h1" : undefined}
        when={focal ? undefined : { iso: post.createdAt, text: f.instant(post.createdAt), link: post.link, edited }}
        action={action}
      />
      {post.replyTo === null ? null : (
        <p class="reply-to">
          <Icon name="reply" size={16} decorative />
          {m.post.inReplyTo} <LinkTo link={post.replyTo.link}>@{post.replyTo.acct}</LinkTo>
        </p>
      )}
      <PostBody post={post} lcp={focal} playback={playback} quotesPage={quotesPage} />
      {focal ? (
        <p class="meta">
          <span>
            {/* The full form: the feed's compact dates link here, and a phone shows no title on hover. */}
            <DateTime iso={post.createdAt} text={f.instant(post.createdAt)} local="full" />
          </span>
          {edited ? (
            <span>
              {history === undefined ? (
                m.post.edited
              ) : (
                <DialogOpener dialog={history} class="quiet-link">
                  <Icon name="edit" size={16} decorative />
                  {m.post.edited}
                </DialogOpener>
              )}
            </span>
          ) : null}
        </p>
      ) : null}
      {variant === "embed" ? (
        post.link === null ? null : (
          <p class="meta">
            <span>
              <LinkTo class="quiet-link" link={post.link}>
                {m.post.viewOn(post.link.host)}
              </LinkTo>
            </span>
          </p>
        )
      ) : (
        <Counts items={post.counts} actions={actions} />
      )}
    </article>
  );
};

// A post too large to show on its page: a slim muted row of why it is not shown, its author's address,
// its date and "Open post", both linking to it, rather than a card.
export const PostStub: FC<{ stub: StubView }> = ({ stub }) => {
  const { m, f } = useUi();
  const date =
    stub.createdAt === null ? null : <DateTime iso={stub.createdAt} text={f.instant(stub.createdAt)} local />;
  const parts: Child[] = [
    <span>{m.post.tooLarge}</span>,
    ...(stub.address === null ? [] : [<span class="handle">{stub.address}</span>]),
    ...(date === null
      ? []
      : [
          <span>
            {stub.link === null ? (
              date
            ) : (
              <LinkTo class="quiet-link" link={stub.link}>
                {date}
              </LinkTo>
            )}
          </span>,
        ]),
    ...(stub.link === null
      ? []
      : [
          <span>
            <LinkTo class="quiet-link" link={stub.link}>
              {m.post.open}
            </LinkTo>
          </span>,
        ]),
  ];
  return (
    <article class="stub">
      <p class="meta">{parts}</p>
    </article>
  );
};

// A paged list of posts (PagedList): its items, each an <li>, then its pager. Newest first by default; an
// oldest-first list names its links by `texts`.
export const PostFeed: FC<{
  empty: boolean;
  emptyText: string;
  pager: PagerLinks;
  texts?: PagerTexts | undefined;
  children?: Child;
}> = ({ empty, emptyText, pager, texts, children }) => {
  const { m } = useUi();
  return (
    <PagedList
      empty={empty}
      emptyText={emptyText}
      pager={pager}
      texts={
        texts ?? {
          newer: m.pager.newer,
          older: m.pager.older,
          newerShort: m.pager.newerShort,
          olderShort: m.pager.olderShort,
        }
      }
    >
      <ul class="feed" role="list">
        {children}
      </ul>
    </PagedList>
  );
};

// The posts above a status on its page: its ancestors, oldest first, as a named ordered list; nothing when there are
// none.
export const ThreadUp: FC<{ posts: PostView[] }> = ({ posts }) => {
  const { m } = useUi();
  return posts.length === 0 ? null : (
    <ol class="feed thread" role="list" aria-label={m.a11y.thread}>
      {posts.map((post) => (
        <li>
          <PostCard post={post} variant="feed" />
        </li>
      ))}
    </ol>
  );
};
