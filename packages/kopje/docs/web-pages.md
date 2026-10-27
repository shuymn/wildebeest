# Public web pages

The pages Kopje serves to people who are not using a client: profiles, posts, tags and the pages around them. The plan
and the decisions per page are in issue #1185; this page states the rules every page follows.

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
  its own `lang` where known.
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
  heading has more space above than below (browser job); the sanitizer writes it as a paragraph of one strong.
- Type is `--t1` (meta, hints, counts) to `--t5`, weights 400 (text), 600 (labels, controls, names, a count's
  number) and 700 (headings), line heights 1.6 (text), 1.25 (headings, and a name over its address) and 1 (controls).
  One rule per heading level and role: a page's own h1 (about, tag, settings, setup) is `--t5`, `--t4` on narrow
  screens; the profile's name, which heads its card, is `--t4` at every width; h2 is `--t3`. The documented
  exception is an author or list owner as the h1 (`Who`'s name), which looks exactly as on a feed card (browser job).
  Monospace is one `.mono` style at `--t2`, `code` included. A profile's counts are at `--t2`, each whole.
- Radii, each corner's included, are `--r-control` 10, `--r-inset` 12, `--r-card` 16 and `--r-pill` 999 px; colours
  are tokens on `:root`, with `--primary` and `--on-primary` for a primary button (amber with dark ink in both
  schemes), `--warn` for warnings and `--scrim` for a dialog's backdrop. No colour is written outside `:root`, as a
  hex, a function or a name. An offset (`top`, `inset` and their kin) is 0, auto, a percentage or a step; any other is
  a commented exception, as the bleeds are.
- An icon follows its text: 16 px beside `--t1`, 18 px beside `--t2` (`IconSize`), and the icons of one row (a counts
  row, its Share, a meta line) are one size (browser job). A custom emoji is 1em high wherever it is and centred on the
  capitals beside it (browser job), the one em size outside rich content; its 20px attributes keep its box until it
  loads. An em length anywhere is a commented exception.

**Components** (`src/web/components/`):

- Buttons have one box (`button, .btn`, and a file input's button), as wide as their content. A bare button is the
  neutral one; a page has at most one `.primary` (browser job), and a step that passed offers its action as a default
  one. Only revoking an app is `.danger`. An icon alone is `.btn.icon`, 44 px square (browser job).
- A paged list is `PagedList`: the empty line, the list, then `Pager`, built on `LinkButton`, showing only the sides
  offered, the older one at the row's end. Newest-first lists read "Newer posts" / "Older posts" and "Newer
  accounts" / "Older accounts", oldest-first replies "Earlier replies" / "Later replies"; under 30rem they shorten to
  "Newer" / "Older" ("Earlier" / "Later"), the full label staying the link's name (browser job).
- A link back is `BackLink`, the first child of `main`, outside any card. A link that is chrome (names, counts,
  hashtags, meta lines, the footer, back links, the header's name) is `.quiet-link`, underlined on hover. Without the
  site's chrome, the header's "Kopje" leads to `/`.
- Every profile tab is headed by `ProfileHead`: the same card, its Follow beside the avatar, and the follow dialog.
  The look-up result's Follow is in the card's action slot for an account and at the end of the author's row
  (`Who`'s) for a post, wrapping below the name where both do not fit; it reads "Follow", since what it follows is
  beside it. A page charges each emoji it shows to its allowance once, in document order (the profile's follow
  dialog's title before the posts).
- A post's counts are icons and numbers, each linking to its tab where the post has a page here (a remote post's are
  text). The focal post's further actions sit behind one "Share" button at the counts row's end: `ActionsMenu`, a
  popover of rows (no ARIA menu, no script) that open their dialogs, "Open on your server" and "Embed" (browser job).
- A post too large to show is a slim muted row (`.stub`), its address, date and "Open post". A quote of the page's
  own post (its Quotes tab) is one line, "Quoting this post".
- An alert is `Alert` (ok, warn, fail or info): one box, a bar and icon in the status's colour, the title in bold with
  no colon, the detail small below (browser job). A field's error is `FieldError`, under its field in place of its
  hint, named by the control's `aria-describedby`, the control `aria-invalid` with the fail colour's border.
- An error page is `ErrorView`, the same for the public pages' 404 and the Store-free 404, 500 and 503 apart from the
  chrome; a 500 or a 503 offers "Retry" (the same URL).
- Each form posts its token with the one `Csrf`.

**Structure and text:**

- A page's h1 sits at the top of `main`, outside and above its cards, on every page (browser job). A page's section
  is a `section.stack`: its h2 above its card or list. Pages of sections (about, Featured, settings, setup) hold them
  in `.sections`; setup lists its steps at the top, each with its status. No heading level is skipped.
- A field (label, control, hint in a `.field`) is one group; a form's submit is a block after its fields. Every label
  and a copy field's label share one style. A checkbox or radio is a 20 px `label.check` row in the accent, its text
  in its own column. Profile fields have visible column labels, and a pair stays on one row at every width. Only
  optional fields are marked, as "(optional)", where a form has required ones.
- A page's `<title>` names what its h1 names. A hashtag is written with its `#`, and no tag icon.
- A name with custom emoji goes through `InlineText` everywhere but `<title>` (browser job: the follow dialog's and
  the handoff form's headings).
- Muted text has two roles: `.muted` at the text's size and `.hint` small. An empty line reads "No <things> yet.";
  replies counted but none shown are on other servers, and the line says so; an account that hides its follow lists
  says so ("<name> hides this list.").
- Counts are lowercase (`test/web-format.test.ts`). No colon comes before a date or time ("Ends <date>"); other
  label and value pairs are a `dl` without colons. A sentence ends with a period, a fragment does not.
- An account is named by its full `@user@domain`, as plain muted text. An address in a meta line takes the line's size.
- A meta line's items are elements, and its separators are the stylesheet's, drawn in the gap before an item and
  clipped where the item starts a wrapped line, so no line starts or ends with one; a date stays with its label
  (browser job).
- Dividers go only between items inside a card (`.rows`).
- Every dialog closes by Esc, its close button and an outside click (`closedby="any"`), a form's dialog included: the
  most it loses is a server's domain typed, and one rule for every dialog matters more (this replaces amendment A7's
  light dismiss only where nothing typed is lost). A click inside a dialog keeps it open (browser job).
- A dialog focused on its heading shows the focus ring only for the keyboard (`:focus-visible`, browser job).
- A poll's choice is one outlined row in every state, counted, with its counts hidden or in the edit history; with
  counts shown, an SVG rect behind its text fills its share (the leading choice's in the accent's tint) and the share
  is text at its end (browser job). Inside an edit-history version, its blocks are spaced as a post's.
- A described attachment shows an "ALT" badge (Mastodon's) that opens its description in a popover, without script:
  on an image's bottom left, a video's top left (clear of its controls) and beside an audio player (browser job). A
  missing description shows no marker; an image's link is still named, in hidden text.
- A copy button shows its result in place: a check for a moment after a success, an alert and a note in space kept
  for it after a failure, the result text in a visually hidden status element; the field never changes height
  (browser job).
- An app's consent page names its website by host (the whole URL in hidden text), the account in full and the
  permissions in plain language by group, admin ones in a warning.
