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
  container's gap, never by margins on the children. A negative margin is a deliberate bleed and an em margin is rich
  content's typography; each is commented above its declaration.
- Type is `--t1` (meta, hints, counts) to `--t5`, weights 400 (text), 600 (labels, controls, names) and 700
  (headings), line heights 1.6 (text), 1.25 (headings) and 1 (controls). One rule per heading level and role: a page's
  h1 is `--t5`, `--t4` when it heads a card and on narrow screens; h2 is `--t3`. The documented exception is an author
  or list owner as the h1 (`Who`'s name), which keeps the page-h1 size inside its author row. Monospace is one `.mono`
  style at `--t2`, `code` included.
- Radii are `--r-control` 10, `--r-inset` 12, `--r-card` 16 and `--r-pill` 999 px; colours are tokens on `:root`, with
  `--warn` for warnings and `--scrim` for a dialog's backdrop. No colour is written outside `:root`.
- An icon follows its text: 16 px beside `--t1`, 18 px beside `--t2` (`IconSize`).

**Components** (`src/web/components/`):

- Buttons have one box (`button, .btn`), as wide as their content. A bare button is the neutral one; `.primary` is
  opt-in, at most one per form or section; signing out and revoking are `.danger`; an icon alone is `.btn.icon`, 44 px
  square (browser job).
- A paged list is `PagedList`: the empty line, the list, then `Pager`, built on `LinkButton` and `OffButton`, each side
  keeping its icon where the offered link has it. Newest-first lists read "Newer posts" / "Older posts" and "Newer
  accounts" / "Older accounts"; oldest-first replies "Earlier replies" / "Later replies".
- A link back is `BackLink`, the first child of `main`, outside any card. A link that is chrome (names, counts,
  hashtags, meta lines, the footer, back links) is `.quiet-link`, underlined on hover.
- Every profile tab is headed by `ProfileHead`: the same card, its Follow beside the avatar, and the follow dialog.
  The look-up result's Follow is in the card's action slot for an account and by the author (`Who`'s) for a post.
- An alert is `Alert` (ok, warn, fail or info): one box, a bar and icon in the status's colour, the title in bold with
  no colon, the detail small below (browser job). A field's error is `FieldError`, under its field, named by the
  control's `aria-describedby`, the control `aria-invalid`.
- Each form posts its token with the one `Csrf`.

**Structure and text:**

- A page's section is a `section.stack`: its h2 above its card or list. Pages of sections (about, Featured, settings,
  setup) hold them in `.sections`. Settings and setup make each section or step such a section; no heading level is
  skipped.
- A field (label, control, hint in a `.field`) is one group; a form's submit is a block after its fields. Every label
  and a copy field's label share one style. A checkbox or radio is a `label.check` row, its text in its own column.
  Profile fields have visible column labels, and a pair stays on one row at every width. Only optional fields are
  marked, as "(optional)", where a form has required ones.
- A page's `<title>` names what its h1 names. A hashtag is written with its `#`, and no tag icon.
- A name with custom emoji goes through `InlineText` everywhere but `<title>` (browser job: the follow dialog's and
  the handoff form's headings).
- Muted text has two roles: `.muted` at the text's size and `.hint` small. An empty line reads "No <things> yet.";
  an account that hides its follow lists says so ("<name> hides this list.").
- Counts are lowercase (`test/web-format.test.ts`). No colon comes before a date or time ("Ends <date>"); other
  label and value pairs are a `dl` without colons. A sentence ends with a period, a fragment does not.
- An account is named by its full `@user@domain`, as plain muted text. An address in a meta line takes the line's size.
- A meta line's items are elements, and its separators are the stylesheet's, so no line ends with one and a date stays
  with its label (browser job).
- Dividers go only between items inside a card (`.rows`).
- A dialog focused on its heading shows the focus ring only for the keyboard (`:focus-visible`, browser job).
- A poll's choice is one outlined row in every state; with counts shown, an SVG rect behind its text fills its share
  (the leading choice's in the accent's tint) and the share is text at its end (browser job).
