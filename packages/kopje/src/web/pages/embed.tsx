import type { FC } from "hono/jsx";

import type { Status } from "../../domain/status-presenter";
import { STYLESHEET } from "../asset-versions";
import { Html } from "../components/html";
import { PostCard } from "../components/post";
import { useUi } from "../ui";
import { address, displayName } from "../view/account";
import { emojiAllowance } from "../view/emoji";
import { postView } from "../view/post";

// The script an embed page runs (public/assets/embed-status.js): it answers embed.js's height request.
export const EMBED_SCRIPT = "/assets/embed-status.js";

// The embed page (Mastodon's StatusesController#embed): the status page's status alone, for an iframe on another
// site, with no landmarks and no h1. Links open outside the frame (<base target>, which base-uri 'none' does not
// restrict: it names no URL); the script answers the embedding page's height request and does nothing else.
export const EmbedPage: FC<{ status: Status; domain: string }> = ({ status, domain }) => {
  const { lang, m } = useUi();
  return (
    <Html lang={lang}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <meta name="robots" content="noindex" />
        <base target="_blank" />
        <title>{m.profile.title(displayName(status.account), address(status.account, domain))}</title>
        <link rel="stylesheet" href={STYLESHEET} />
        <link rel="canonical" href={status.url ?? undefined} />
        <script src={EMBED_SCRIPT} async />
      </head>
      <body class="embed">
        <PostCard post={postView(status, null, domain, emojiAllowance())} variant="embed" />
      </body>
    </Html>
  );
};
