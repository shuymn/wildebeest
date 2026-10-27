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
