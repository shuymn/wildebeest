import type { FC } from "hono/jsx";

import { httpUrl } from "../../platform/http-url";
import { Alert, Card, VisuallyHidden } from "../components/basics";
import { Layout } from "../components/layout";
import { Disclosure } from "../components/post";
import { CopyField } from "../components/remote";
import { useUi } from "../ui";
import { scopeGroups } from "../view/scopes";

// The pages of /oauth/authorize (app/authorize.tsx): the consent form and the out-of-band code. Script-free (WEB-2),
// and without the site's chrome: the flow reads only what it checks from the Store. Its refusals are MessagePage.

// The fields the consent form posts back to /oauth/authorize, where every one of them is validated again.
export type ConsentFields = {
  client_id: string;
  redirect_uri: string;
  scope: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
};

// The consent form: the app, its website as its host only (the whole URL in hidden text, so a long one never runs on),
// the account by its full address, and the permissions it asks for in plain language by group, with the scopes' own
// names behind a disclosure; admin scopes stand apart in a danger alert. The page's heading is above its card, as
// every page's.
export const ConsentPage: FC<{
  appName: string;
  website: string | null;
  username: string;
  // The instance's domain, which names the account in full.
  domain: string;
  scopes: string[];
  fields: ConsentFields;
  // The instance's own web UI (domain/web-session.ts): the same decision, worded as signing in.
  firstParty?: boolean;
}> = ({ appName, website, username, domain, scopes, fields, firstParty = false }) => {
  const { m } = useUi();
  const title = firstParty ? m.signIn.signIn : m.oauth.title(appName);
  const account = `@${username}@${domain}`;
  const host = website === null ? null : (httpUrl(website)?.host ?? website);
  const grouped = scopeGroups(scopes);
  const admin = grouped.find(({ group }) => group === "admin");
  return (
    <Layout title={title} chrome={null}>
      <h1>{title}</h1>
      <Card as="section" class="pad">
        {firstParty ? (
          <p>
            {m.signIn.signInAs} <strong>{account}</strong>?
          </p>
        ) : (
          <>
            {admin === undefined ? null : (
              <Alert status="fail" title={m.oauth.admin}>
                <p>{m.oauth.scopeGroups.admin}</p>
              </Alert>
            )}
            {/* The website is the client's own claim at registration: shown as text, never followed from here. */}
            <dl class="fields">
              {host === null ? null : (
                <div>
                  <dt>{m.oauth.website}</dt>
                  {/* Its host, one line; the whole of it for assistive technology (no title). */}
                  <dd class="oneline">
                    {host}
                    {website === host ? null : <VisuallyHidden>{` (${website})`}</VisuallyHidden>}
                  </dd>
                </div>
              )}
              <div>
                <dt>{m.oauth.account}</dt>
                <dd>
                  <strong>{account}</strong>
                </dd>
              </div>
              <div>
                <dt>{m.oauth.scopes}</dt>
                <dd>
                  <ul class="scopes" role="list">
                    {grouped
                      .filter(({ group }) => group !== "admin")
                      .map(({ group }) => (
                        <li>{m.oauth.scopeGroups[group]}</li>
                      ))}
                  </ul>
                </dd>
              </div>
            </dl>
            {/* The scopes' own names, for whoever wants them, out of the plain-language list. */}
            <details class="tech">
              <summary>
                <span>{m.oauth.technicalScopes}</span>
                <Disclosure />
              </summary>
              <div class="stack">
                <p class="mono hint">{scopes.join(" ")}</p>
              </div>
            </details>
          </>
        )}
        <form method="post" action="/oauth/authorize">
          {Object.entries(fields).map(([name, value]) =>
            value === undefined ? null : <input type="hidden" name={name} value={value} />,
          )}
          <div class="actions">
            <button type="submit" class="btn primary" name="decision" value="approve">
              {firstParty ? m.signIn.signIn : m.oauth.approve}
            </button>
            <button type="submit" class="btn" name="decision" value="deny">
              {firstParty ? m.signIn.cancel : m.oauth.deny}
            </button>
          </div>
        </form>
      </Card>
    </Layout>
  );
};

// For urn:ietf:wg:oauth:2.0:oob: the code, whole and wrapping, to select and copy by hand (CopyField without the L1
// bundle: the page runs no script).
export const CodePage: FC<{ code: string }> = ({ code }) => {
  const { m } = useUi();
  return (
    <Layout title={m.oauth.codeTitle} chrome={null}>
      <h1>{m.oauth.codeTitle}</h1>
      <Card as="section" class="pad">
        <CopyField value={code} label={m.oauth.code} hint={m.oauth.codePrompt} copyLabel={m.copy.copyCode} />
      </Card>
    </Layout>
  );
};
