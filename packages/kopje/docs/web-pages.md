# Public web pages

The pages Kopje serves to people who are not using a client: profiles, posts, tags and the pages around them. This page
states the rules every page follows.

- **Full pages, no client-side navigation.** Every link and tab loads a whole server-rendered page. No page swaps part
  of itself with fetched HTML, and no page routes on the client.
- **Pages work without script.** Script is used only for what HTML and CSS cannot do, such as copying an account's
  address, and its control appears only once the script runs. Each script is one standalone file under `/assets`,
  named exactly by the page's CSP, and is agreed per component before it is added. The public pages' components share
  one such file, the L1 bundle, built from `src/client/` by `scripts/build-assets.mjs` and published under a
  fingerprinted name (`/assets/kopje.<hash>.js`) beside the stylesheet's; what its pages' CSP allows is WEB-2 in
  [threat-model.md](threat-model.md).
- **One stylesheet, served minified.** All pages share `src/web/kopje.css`, plain CSS with native nesting and
  `light-dark()` and no preprocessor. `scripts/build-assets.mjs` publishes it as `/assets/kopje.<hash>.css` with its
  comments and whitespace removed by the pinned esbuild and nothing else rewritten; the browser job checks that
  Chromium reads the same rules from both, and the budget of 16 KiB raw and 5 KiB gzip applies to the served file
  (`test-node/stylesheet.test.ts`). Comments explaining a rule stay in the source.
- **Current browsers only.** Pages may use current HTML and CSS, such as `<dialog>` opened with
  `command="show-modal"`, without fallbacks for older browsers.
- **English UI, ready for translation.** Kopje's own text comes from the string catalogue (`STRINGS` in
  `src/web/strings.ts`), never written inline in a page. Text with numbers or names is a function of its arguments, and
  dates and numbers are formatted with `Intl`. The page's `lang` is the UI language, and user-written content carries
  its own `lang`: a post's language where it has one, and `lang=""` (unknown) where it has none, so the text does not
  take the UI language's glyphs and hyphenation. An account records no language, so its name, bio and fields, and an
  edit history's versions, are always `lang=""`.
- **No text that describes the page.** Pages do not explain what they show or leave out (for example "showing only
  …"). Headings, labels and navigation names are allowed; other UI text states an action, a result or a condition for
  acting. The edit history's notice that older versions are left out is the one exception (VIS-4).
- **The system colour scheme.** Pages follow `prefers-color-scheme` and declare `color-scheme`. There is no theme
  switch.

## UI rules

Every page follows these, with the tokens and components named. The embed (`src/web/pages/embed.tsx`) is the one
exception for frame, landmarks and chrome, and still uses the tokens. Where a rule is checked, the check is named.

**Tokens** (`src/web/kopje.css`, held by `test-node/stylesheet.test.ts`):

- Spacing is the scale `--s1` to `--s6`: icon to label, one group (a field's label, control and hint; a name and its
  address), items in a row, blocks inside a card or section, a card's padding and between cards, and a page's sections.
  Every card's padding is `--pad`, `--s5` stepped down to `--s4` on narrow screens. Siblings are spaced by their
  container's gap, never by margins on the children; a post's content is spaced the same behind a content warning as
  without one (browser job). A negative margin is a deliberate bleed and an em margin is rich content's typography;
  each is commented above its declaration. In an operator's document (the policies, the about page's description), a
  heading has more space above than below (browser job). Its sanitizer keeps the operator's headings as h2 to h4 under
  the page's own h1; federated HTML keeps Mastodon's allowlist, where a heading becomes a paragraph of one strong.
- Type is `--t1` (meta, hints, counts) to `--t5`, weights 400 (text), 600 (labels, controls, names, a count's
  number) and 700 (headings), line heights 1.6 (text), 1.25 (headings, and a name over its address) and 1 (controls).
  One rule per heading level and role: a page's own h1 (about, tag, settings, setup) is `--t5`, `--t4` on narrow
  screens; the profile's name, which heads its card, is `--t4` at every width; h2 is `--t3`. The documented
  exception is an author or list owner as the h1 (`Who`'s name), which looks exactly as on a feed card (browser job).
  Monospace is one `.mono` style at `--t2`, `code` included: values to copy, paths, and setting and secret names
  (`SETUP_TOKEN`), never an email address. A profile's counts are at `--t2`, each whole.
- Radii, each corner's included, are `--r-control` 10, `--r-inset` 12, `--r-card` 16 and `--r-pill` 999 px; colours
  are tokens on `:root`, with `--primary` and `--on-primary` for a primary button (amber with dark ink in both
  schemes), `--warn` for warnings and `--scrim` for a dialog's backdrop. No colour is written outside `:root`, as a
  hex, a function or a name. An offset (`top`, `inset` and their kin) is 0, auto, a percentage or a step; any other is
  a commented exception, as the bleeds are. A token is defined exactly once, in the top-level `:root`, at its
  canonical value; the only redefinitions are `--pad` as a step on narrow screens and `--tone` as a colour token in a
  status's rule, and no custom property is registered (`@property`), so no component can redefine a token to pass
  these checks (`test-node/stylesheet.test.ts`).
- An icon follows its text: 16 px beside `--t1`, 18 px beside `--t2` (`IconSize`), and the icons of one row (a counts
  row, its Share, a meta line) are one size (browser job). A custom emoji is 1em high wherever it is and centred on the
  capitals beside it (browser job), the one em size outside rich content; its 20px attributes keep its box until it
  loads. An em length anywhere is a commented exception.

**Components** (`src/web/components/`):

- Buttons have one box (`button, .btn`, and a file input's button), as wide as their content, and five kinds: the
  default (a bare button), `.primary`, `.quiet`, `.danger` and `.icon`; no other modifier exists, in the stylesheet (any
  class of a compound that is a button, wherever it is written) or the markup (`test-node/stylesheet.test.ts`, browser
  job). A page has at most one `.primary` (browser job), and a step that passed offers its action as a default one.
  Revoking an app and signing out the other sessions (which those devices cannot undo) are `.danger`; signing out and
  leaving setup are default. An icon alone is `.btn.icon`, 44 px square (browser job). The ALT badge and a quiet link
  are components of their own, not button kinds.
- Every class the stylesheet styles is named by a literal in a class expression of the source (a `class` or
  `className` attribute or property, or a class map one reads, such as `ALERT_CLASS`), or is one of the sanitized
  content's own classes (`test-node/stylesheet.test.ts`), counted as whole whitespace-separated tokens of a complete
  literal: no rule is left for markup that is gone, a stray or joined string keeps none alive, and no class is built
  from a value.
- A paged list is `PagedList`: the empty line, the list, then `Pager`, built on `LinkButton`, showing only the sides
  offered (`rel="prev"` and `rel="next"`), the older one at the row's end. Newest-first lists read "Newer posts" /
  "Older posts" and "Newer accounts" / "Older accounts", oldest-first replies "Earlier replies" / "Later replies";
  under 30rem they shorten to "Newer" / "Older" ("Earlier" / "Later"), the full label staying the link's name
  (browser job).
- There is one quiet link, `.quiet-link`: chrome rather than running text (names, counts, hashtags, meta lines, the
  footer, the header's name, a back link, and the meta line's "Edited", a button), in its context's colour, its icon
  `--s1` from its text, a 24px target at least, underlined on hover. A link back is `BackLink`, a quiet link that is
  the first child of `main`, outside any card, small and a 44px target. Without the site's chrome, the header's
  "Kopje" leads to `/`. A quiet link that stands alone as a page's action (settings' View profile) is underlined too
  (`.underlined`), so it reads as a link (browser job).
- A link inside body text (posts, bios, the about page, documents) is underlined; a link the sanitizer emptied of its
  href (not http(s)) is text, in the text's colour (browser job).
- There is one one-line utility, `.oneline`: the text cut with an ellipsis, the whole kept (a heading naming a server,
  a website's host, the embed code); and one two-line one, `.clamp` (the handoff's post text).
- A row with an end action (the look-up result's Follow by the author, an authorized app's Revoke) insets it from the
  card's edge as the row's start is. In a row with an avatar its centre is the avatar's (the name and address run
  lower); in a row without one it is centred in the row. Where it wraps below the row's text, it starts its line at
  the content edge (browser job).
- Every profile tab is headed by `ProfileHead`: the same card, its Follow beside the avatar, and the follow dialog.
  The look-up result's Follow is in the card's action slot for an account and at the end of the author's row
  (`Who`'s) for a post, wrapping below the name where both do not fit; it reads "Follow", since what it follows is
  beside it. A page charges each emoji it shows to its allowance once, in document order (the profile's follow
  dialog's title before the posts).
- The tabs sit on one line down to a phone's width (spread over the row there, at least `--s2` apart) and never scroll
  sideways, which would clip their focus rings. The current tab is the ink with the accent's underline; a hovered one
  takes the ink and a thin neutral underline, so hover never reads as current. A layout that must hold at a phone's
  width (the tabs, an authorized app's row) is checked in a wide sans too (Verdana or DejaVu Sans), not only the
  host's (browser job).
- A post's counts are icons and numbers, each linking to its tab where the post has a page here: a local account's, by
  the author's identity, never by the host of the URL the post supplies (a remote post's are text). The focal post's
  further actions sit behind one "Share" button at the counts row's end: `ActionsMenu`, a popover of rows (no ARIA menu,
  no script) that open their dialogs, "Open on your server" and "Embed". When such a dialog closes, the L1 bundle
  returns focus to "Share" (its opener is hidden by then); without script it leaves the dialog (browser job).
- The handoff page starts its card with the target: the account's row, or the post's author's row and the start of
  its text, plain, two lines at most (its warning instead where it has one), from the page's own anonymous read;
  then "Continue" with the whole host, then the search fallback. The row links nowhere: the page's one link is the
  handoff (browser job).
- A post too large to show is a slim muted row (`.stub`): why ("Too large to show here."), its address, date and
  "Open post". A quote of the page's own post (its Quotes tab) is one line, "Quoting this post".
- An alert is `Alert` (ok, warn or fail): one box, a bar and icon in the status's colour, the title in bold with
  no colon, the detail small below (browser job). A field's error is `FieldError`, under its field in place of its
  hint, named by the control's `aria-describedby`, the control `aria-invalid` with the fail colour's border.
- An error page is `ErrorView`, the same for the public pages' 404 and the Store-free 404, 500 and 503 apart from the
  chrome; a 500 or a 503 offers "Retry" (the same URL), its one primary button.
- Each form posts its token with the one `Csrf`.

**Structure and text:**

- A page's h1 sits at the top of `main`, outside and above its cards, on every page (browser job). A page's section
  is a `section.stack`: its h2 above its card or list. Pages of sections (about, Featured, settings, setup) hold them
  in `.sections`; setup lists its steps at the top, each with its status chip in the status's colour as the step's
  alert has it (ok, warn, fail; not run muted, browser job). Step 1 names the confirmed domain once, and shows no pass
  alert repeating it. No heading level is skipped.
- A field (label, control, hint in a `.field`) is one group; a form's submit is a block after its fields. Every label
  and a copy field's label share one style. A checkbox or radio is a 20 px `label.check` row in the accent, its text in
  its own column; its label is plain words without API terms in brackets, and where more helps, a hint under the text
  describes the box (`aria-describedby`; the box is named by the label alone, browser job). Profile fields have visible
  column labels, and a pair stays on one row at every width. Only optional fields are marked, as "(optional)", where a
  form has required ones.
- A page's `<title>` names what its h1 names. A hashtag is written with its `#`, and no tag icon.
- A name with custom emoji goes through `InlineText` everywhere but `<title>` (browser job: the follow dialog's and
  the handoff form's headings).
- Muted text has two roles: `.muted` at the text's size and `.hint` small. An empty line reads "No <things> yet.";
  replies counted but none shown are on other servers, and the line says so; an account that hides its follow lists
  says so ("<name> hides this list.").
- Counts are lowercase (`test/web-format.test.ts`). No colon comes before a date or time ("Ends <date>"); other
  label and value pairs are a `dl` without colons. A sentence ends with a period, a fragment does not.
- An account is named by its full `@user@domain`. On the line under a name (`Who`, account rows, the profile card)
  it is muted and takes the line's size; inside a sentence (the sign-in confirmation, the consent page's account,
  setup's admin, a follow's outcome) it is that sentence's content, `<strong>` in the ink (browser job).
- A value that cannot change is a read-only field (settings' address): `readonly`, never `disabled`, so it stays
  readable, focusable and copyable; the soft ground with a lock at its end; outside any form, so it is never posted
  (browser job).
- A meta line's items are elements, and its separators are the stylesheet's, drawn in the gap before an item and
  clipped where the item starts a wrapped line, so no line starts or ends with one; a date stays with its label
  (browser job).
- Dividers go only between items inside a card (`.rows`).
- A list's shape follows what it lists, not the page or tab it sits on: a list of posts (replies, quotes, timelines)
  is one card a post; a list of accounts (boosts, favourites, followers, following, Featured accounts) is rows in one
  card.
- Every dialog closes by Esc, its close button and an outside click (`closedby="any"`), a form's dialog included: the
  most it loses is a server's domain typed, and one rule for every dialog matters more. A click inside a dialog keeps
  it open (browser job).
- A dialog focused on its heading shows the focus ring only for the keyboard (`:focus-visible`, browser job).
- A poll's choice is one outlined row in every state, counted, with its counts hidden or in the edit history; with
  counts shown, an SVG rect behind its text fills its share (the leading choice's in the accent's tint) and the share
  is text at its end (browser job). Inside an edit-history version, its blocks are spaced as a post's. An open poll
  whose counts are hidden says "Results appear when the poll ends." under its meta line; an ended one, and an
  edit-history version, do not.
- A described attachment shows an "ALT" badge (Mastodon's) that opens its description in a popover, without script: on
  an image's bottom left, a video's top left (clear of its controls), and for audio in a slot above the player, kept
  without a badge, so every player is full width and in line. The popover is anchored below its badge, or above it where
  there is no room, never over it (browser job). A player is named by the popover's text (`aria-labelledby`), so its
  description is on the page once; an image's is its `alt` too, a second copy its page's read counts (`altCopyBytes`,
  [response-inventory.md](response-inventory.md)). The descriptions are in the post's language (`lang`). A missing
  description shows no marker; an image's link is still named, in hidden text.
- A copy field is named by a short noun ("Handle", "Post URL", "Embed code", "Code"), with what to do with the value
  in a hint under it. Its button shows its result in place: a check for a moment after a success, an alert after a
  failure and the failure's note in the hint's place (the space of the longer kept), the result text in a visually
  hidden status element; the field never changes height (browser job). A result that settles after the dialog closed,
  or after a newer click, changes nothing (`test-node/copy.test.ts`). A page without the L1 bundle (the handoff
  pages, the code page) shows the value alone, with no button, status element or kept space, since nothing would run
  them (browser job).
- Settings shows one profile-field row for each field an account may store (`MAX_FIELDS`), so a save from settings
  never drops a stored field.
- An app's consent page names its website by host (the whole URL in hidden text), the account in full and the
  permissions in plain language by group, the scopes' own names behind a "Technical scopes" disclosure, and admin
  ones in a fail (danger) alert: amber reads as "go" on this site. Settings' authorized apps name the same groups
  (`scopeGroups`, one helper for both), Admin in the danger colour, in an item that may wrap (browser job).
- The about page's "Contact and details" card lists the contact account (its full address, linked to its profile), then
  the contact email (a `mailto:` link in the body font, its parts percent-encoded, text where it is not one plain
  address), the documents, and "Software": "Kopje <version>", NodeInfo's version, linked to the repository.
