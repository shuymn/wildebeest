import { type Client, type IntrospectionCaller, OOB_REDIRECT_URI } from "../domain/oauth";
import { railsBlank } from "../platform/rails-blank";
import { APP_NAME_LIMIT, isAppWebsite } from "../platform/stored-bounds";
import { DEFAULT_SCOPES, parseScopes, SCOPES } from "../security/scopes";
import { PKCE_VERIFIER, pkceChallenge, sha256Hex } from "../security/tokens";
import { bearerToken } from "./access";
import {
  type ApiContext,
  type ApiHandler,
  authorized,
  credential,
  present,
  storeCall,
  userCredential,
  vapidKey,
} from "./context";
import { bearerChallenge, INVALID_TOKEN, mastodonError } from "./errors";
import { type Params, type ReadOptions, readParams } from "./params";

// App registration, the OAuth token, revocation, token info, introspection and userinfo endpoints, and the
// authorization server metadata. /oauth/authorize (behind Access) lives in app/authorize.tsx.

const MAX_REDIRECT_URIS = 10;
const MAX_URI = 2000;

// RES-6: anonymous registration is limited per client IP by the Workers Rate Limiting binding (wrangler.jsonc), before
// the body is read, as Mastodon throttles its unauthenticated API per IP; the Store bounds what registrations may
// keep (domain/oauth.ts). The binding counts per Cloudflare location and is eventually consistent, so the limit is
// approximate; the Store's bound is exact.
// The application as GET /api/v1/apps/verify_credentials answers it (REST::ApplicationSerializer), and as
// POST /api/v1/apps answers it (REST::CredentialApplicationSerializer); test-node/mastodon-entities.test.ts compares
// both with Mastodon's fields.
// id is the client_id, Kopje's only stable key of an application (docs/mastodon-deviations.md, "Instance and apps").
export type Application = {
  id: string;
  name: string;
  website: string | null;
  scopes: string[];
  redirect_uris: string[];
  vapid_key: string;
  redirect_uri: string;
};

export type CredentialApplication = Application & {
  client_id: string;
  client_secret: string;
  client_secret_expires_at: 0;
};

// The scopes and redirect URIs as registered, in order; redirect_uri joins them with newlines, as Mastodon stores them.
function presentApplication(client: Client, env: Env): Application {
  return {
    id: client.id,
    name: client.name,
    website: client.website,
    scopes: client.scopes,
    redirect_uris: client.redirectUris,
    vapid_key: vapidKey(env),
    redirect_uri: client.redirectUris.join("\n"),
  };
}

export const registerApp: ApiHandler = async (c, deps) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (!(await c.env.APP_REGISTRATION_LIMIT.limit({ key: ip })).success) {
    await c.req.raw.body?.cancel();
    return mastodonError(429, "Too many requests");
  }
  const result = await readParams(c.req.raw);
  if (!result.ok) {
    return mastodonError(result.status, "Malformed request body");
  }
  const p = result.params;
  const name = (p.get("client_name") ?? "").trim();
  const redirectUris = p.getAll("redirect_uris").flatMap((value) => value.split(/\s+/).filter((uri) => uri !== ""));
  const scopes = parseScopes(p.get("scopes"));
  const website = (p.get("website") ?? "").trim();
  const problems: string[] = [];
  // Mastodon's APP_NAME_LIMIT in code points (app/lib/application_extension.rb:6, :15, v4.5.11), counted only once
  // the code units allow them (two a code point at most).
  if (name === "" || name.length > 2 * APP_NAME_LIMIT || [...name].length > APP_NAME_LIMIT) {
    problems.push(`Application name can't be blank or longer than ${APP_NAME_LIMIT} characters`);
  }
  if (redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS || !redirectUris.every(validRedirectUri)) {
    problems.push("Redirect URI must be an absolute URI.");
  }
  if (scopes === null) {
    problems.push("Scopes are invalid");
  }
  if (website !== "" && !isAppWebsite(website)) {
    problems.push("Website is invalid");
  }
  if (problems.length > 0 || scopes === null) {
    return mastodonError(422, `Validation failed: ${problems.join(", ")}`);
  }
  const clientId = deps.randomToken();
  const secret = deps.randomToken();
  const registered = await storeCall(c, deps, (s, b) =>
    s.registerApp(b, {
      clientId,
      secret,
      name,
      redirectUris: [...new Set(redirectUris)],
      website: website === "" ? null : website,
      scopes,
      now: deps.now(),
    }),
  );
  if (registered.status === "over_budget") {
    return mastodonError(429, "Too many applications are waiting for authorization. Try again later.");
  }
  return c.json({
    ...presentApplication(registered.client, c.env),
    client_id: clientId,
    client_secret: secret,
    client_secret_expires_at: 0,
  } satisfies CredentialApplication);
};

// Any valid token, app tokens included; the application its token was issued to, without its credentials.
export const verifyApp: ApiHandler = async (c, deps) => {
  const token = credential(c, deps);
  const client = authorized(await storeCall(c, deps, (s, b) => s.appOfCredential(b, token)));
  return c.json(presentApplication(client, c.env) satisfies Application);
};

// Absolute, no fragment (RFC 6749 §3.1.2), and not a script URL. Custom schemes of native apps are allowed.
export function validRedirectUri(uri: string): boolean {
  if (uri === OOB_REDIRECT_URI) {
    return true;
  }
  const url = uri.length > MAX_URI ? null : parseUrl(uri);
  return url !== null && url.hash === "" && !["javascript:", "data:", "vbscript:", "file:"].includes(url.protocol);
}

function parseUrl(uri: string): URL | null {
  try {
    return new URL(uri);
  } catch {
    return null;
  }
}

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

// RFC 6749 §5.2 error responses.
function oauthError(
  status: number,
  error: string,
  description: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json({ error, error_description: description }, { status, headers: { ...NO_STORE, ...headers } });
}

// A failed client authentication, at /oauth/token and (RFC 7009 §2.2.1) at /oauth/revoke: 401 with the
// authentication scheme the endpoint accepts.
const INVALID_CLIENT = () =>
  oauthError(401, "invalid_client", "Client authentication failed due to unknown client or invalid secret.", {
    "www-authenticate": 'Basic realm="oauth", charset="UTF-8"',
  });
const INVALID_GRANT = () =>
  oauthError(
    400,
    "invalid_grant",
    "The provided authorization grant is invalid, expired, revoked or was already used.",
  );
const INVALID_SCOPE = () => oauthError(400, "invalid_scope", "The requested scope is invalid, unknown, or malformed.");

// Doorkeeper's OAuth::ErrorResponse, as /oauth/token/info and /oauth/introspect answer it: the body without blank
// members, and a Bearer challenge naming the error whatever it is.
function doorkeeperError(status: number, error: string, description: string, state?: string): Response {
  return Response.json(
    { error, error_description: description, ...(state === undefined ? {} : { state }) },
    { status, headers: { ...NO_STORE, "www-authenticate": bearerChallenge(description, error) } },
  );
}

// A bearer token Doorkeeper refuses: OAuth::InvalidTokenResponse, whose state is always "unauthorized".
const INVALID_BEARER = (description = INVALID_TOKEN) =>
  doorkeeperError(401, "invalid_token", description, "unauthorized");
const EXPIRED_TOKEN = "The access token expired";

const TOKEN_PARAMS = ["grant_type", "code", "redirect_uri", "code_verifier", "scope", "client_id", "client_secret"];
const REVOKE_PARAMS = ["token", "token_type_hint", "client_id", "client_secret"];
// token_type_hint is read only as a scalar: Kopje has no refresh tokens, so every token is looked up as an access
// token.
const INTROSPECT_PARAMS = REVOKE_PARAMS;

// A request error found before anything else: a repeated scalar parameter, or more than one client authentication
// method (RFC 6749 §2.3: Basic and client_secret in the body).
function requestError(c: ApiContext, p: Params, scalars: readonly string[]): Response | null {
  const repeated = p.repeated(scalars);
  if (repeated !== undefined) {
    return oauthError(400, "invalid_request", `The ${repeated} parameter is repeated.`);
  }
  if (/^Basic\s/i.test(c.req.header("authorization") ?? "") && p.get("client_secret") !== undefined) {
    return oauthError(400, "invalid_request", "Only one client authentication method can be used.");
  }
  return null;
}

// The parameters of /oauth/token, /oauth/revoke or /oauth/introspect, or the error answer to a body that cannot be
// read or to a request error found by requestError.
async function oauthParams(
  c: ApiContext,
  scalars: readonly string[],
  options: ReadOptions = {},
): Promise<Params | Response> {
  const result = await readParams(c.req.raw, options);
  if (!result.ok) {
    return oauthError(result.status, "invalid_request", "The request body could not be read.");
  }
  return requestError(c, result.params, scalars) ?? result.params;
}

type ClientCredentials = { clientId: string; clientSecret: string };

// client_secret_basic: undefined without a Basic header, null for one that does not decode. Without a colon the
// whole value is the id and the secret is absent (Doorkeeper's Credentials.from_basic, split(/:/, 2)).
function basicCredentials(c: ApiContext): { clientId: string; clientSecret: string | undefined } | null | undefined {
  const basic = /^Basic\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
  if (basic?.[1] === undefined) {
    return undefined;
  }
  try {
    const decoded = atob(basic[1]);
    const colon = decoded.indexOf(":");
    return colon === -1
      ? { clientId: decodeURIComponent(decoded), clientSecret: undefined }
      : {
          clientId: decodeURIComponent(decoded.slice(0, colon)),
          clientSecret: decodeURIComponent(decoded.slice(colon + 1)),
        };
  } catch {
    return null;
  }
}

// client_secret_post or client_secret_basic.
function clientCredentials(c: ApiContext, p: Params): ClientCredentials | null {
  const basic = basicCredentials(c);
  if (basic !== undefined) {
    // /oauth/token and /oauth/revoke need both halves: a Basic value without a secret authenticates no client.
    return basic?.clientSecret === undefined ? null : { clientId: basic.clientId, clientSecret: basic.clientSecret };
  }
  const clientId = p.get("client_id");
  const clientSecret = p.get("client_secret");
  return clientId === undefined || clientSecret === undefined ? null : { clientId, clientSecret };
}

export const tokenHandler: ApiHandler = async (c, deps) => {
  const p = await oauthParams(c, TOKEN_PARAMS);
  if (p instanceof Response) {
    return p;
  }
  const client = clientCredentials(c, p);
  if (client === null) {
    return INVALID_CLIENT();
  }
  const token = deps.randomToken();
  const tokenHash = await sha256Hex(token);
  const now = deps.now();
  const grantType = p.get("grant_type");
  let outcome;
  if (grantType === "authorization_code") {
    const code = p.get("code");
    const redirectUri = p.get("redirect_uri");
    const verifier = p.get("code_verifier");
    if (code === undefined || redirectUri === undefined) {
      return oauthError(400, "invalid_request", "code and redirect_uri are required.");
    }
    if (verifier !== undefined && !PKCE_VERIFIER.test(verifier)) {
      return INVALID_GRANT();
    }
    const codeHash = await sha256Hex(code);
    const verifierChallenge = verifier === undefined ? null : await pkceChallenge(verifier);
    outcome = await storeCall(c, deps, (s, b) =>
      s.exchangeCode(b, { ...client, codeHash, redirectUri, verifierChallenge, tokenHash, now }),
    );
  } else if (grantType === "client_credentials") {
    const scopes = parseScopes(p.get("scope"), DEFAULT_SCOPES);
    if (scopes === null) {
      return INVALID_SCOPE();
    }
    outcome = await storeCall(c, deps, (s, b) => s.issueAppToken(b, { ...client, scopes, tokenHash, now }));
  } else {
    return oauthError(
      400,
      "unsupported_grant_type",
      "The authorization grant type is not supported by the authorization server.",
    );
  }
  switch (outcome.status) {
    case "ok":
      return c.json(
        {
          access_token: token,
          token_type: "Bearer",
          scope: outcome.scopes.join(" "),
          created_at: Math.floor(now / 1000),
        },
        200,
        NO_STORE,
      );
    case "invalid_client":
      return INVALID_CLIENT();
    case "invalid_grant":
      return INVALID_GRANT();
    case "invalid_scope":
      return INVALID_SCOPE();
  }
};

// RFC 7009. The client must authenticate (a failure is invalid_client, §2.2.1); an unknown token is still a success.
export const revokeHandler: ApiHandler = async (c, deps) => {
  const p = await oauthParams(c, REVOKE_PARAMS);
  if (p instanceof Response) {
    return p;
  }
  const client = clientCredentials(c, p);
  const token = p.get("token");
  if (client === null) {
    return INVALID_CLIENT();
  }
  if (token === undefined) {
    return oauthError(400, "invalid_request", "token is required.");
  }
  const tokenHash = await sha256Hex(token);
  const outcome = await storeCall(c, deps, (s, b) => s.revokeToken(b, { ...client, tokenHash }));
  if (outcome.status === "invalid_client") {
    return INVALID_CLIENT();
  }
  return c.json({});
};

// GET /oauth/token/info (Doorkeeper's TokenInfoController): the token the Authorization header presents, never one
// of the access_token or bearer_token parameters (tokens never come from URLs, VIS-26). A token that is not valid,
// a suspended account's included (AUTH-1), is Doorkeeper's invalid_token. resource_owner_id is the account id, a
// string: Kopje has no separate user id, and ids do not fit a JS number (domain/ids.ts).
export const tokenInfo: ApiHandler = async (c, deps) => {
  const token = bearerToken(c.req.header("authorization"));
  if (token === undefined) {
    return INVALID_BEARER();
  }
  const tokenHash = await sha256Hex(token);
  const now = deps.now();
  const details = await storeCall(c, deps, (s, b) => s.inspectToken(b, { tokenHash, now }));
  if (details === null) {
    return INVALID_BEARER();
  }
  return c.json(
    {
      resource_owner_id: details.accountId,
      scope: details.scopes,
      // Doorkeeper's expires_in: null for a token without expiry, else the seconds left, rounded, at least 0.
      expires_in:
        details.expiresAt === null ? null : Math.max(0, Math.round((Date.parse(details.expiresAt) - now) / 1000)),
      application: { uid: details.clientId },
      created_at: Math.floor(Date.parse(details.createdAt) / 1000),
    },
    200,
    NO_STORE,
  );
};

// POST /oauth/introspect (RFC 7662, Doorkeeper's TokensController#introspect). Parameters come from the body only: a
// token or client secret in the query is absent (secrets never come from URLs, VIS-26). The caller is chosen as
// Doorkeeper chooses it (Client::Credentials.from_request): client credentials whose id is not blank (Basic, then
// client_id; a Basic header that does not decode names none) first, else the Authorization bearer token, else 400.
// An inactive token answers {"active":false} alone (RFC 7662 §2.2); a token without expiry has Doorkeeper's exp 0.
export const introspect: ApiHandler = async (c, deps) => {
  const p = await oauthParams(c, INTROSPECT_PARAMS, { bodyOnly: true });
  if (p instanceof Response) {
    return p;
  }
  const authorization = c.req.header("authorization") ?? "";
  const basic = basicCredentials(c);
  const clientId = p.get("client_id");
  const client =
    basic !== undefined && basic !== null && !railsBlank(basic.clientId)
      ? basic
      : clientId !== undefined && !railsBlank(clientId)
        ? { clientId, clientSecret: p.get("client_secret") }
        : null;
  let caller: IntrospectionCaller;
  if (client !== null) {
    if (client.clientSecret === undefined) {
      return INVALID_CLIENT();
    }
    caller = { kind: "client", clientId: client.clientId, clientSecret: client.clientSecret };
  } else {
    const bearer = bearerToken(authorization);
    if (bearer === undefined) {
      return UNAUTHORIZED_INTROSPECTION();
    }
    caller = { kind: "bearer", tokenHash: await sha256Hex(bearer) };
  }
  const token = p.get("token");
  const targetHash = token === undefined ? null : await sha256Hex(token);
  const outcome = await storeCall(c, deps, (s, b) => s.introspectToken(b, { targetHash, now: deps.now(), caller }));
  switch (outcome.status) {
    case "invalid_client":
      return INVALID_CLIENT();
    case "unauthorized":
      return UNAUTHORIZED_INTROSPECTION();
    case "invalid_token":
      return INVALID_BEARER(outcome.expired ? EXPIRED_TOKEN : INVALID_TOKEN);
    case "ok": {
      const details = outcome.token;
      if (details === null) {
        return c.json({ active: false }, 200, NO_STORE);
      }
      return c.json(
        {
          active: true,
          scope: details.scopes.join(" "),
          client_id: details.clientId,
          token_type: "Bearer",
          exp: details.expiresAt === null ? 0 : Math.floor(Date.parse(details.expiresAt) / 1000),
          iat: Math.floor(Date.parse(details.createdAt) / 1000),
        },
        200,
        NO_STORE,
      );
    }
  }
};

// Doorkeeper's answer when introspection names no caller (doorkeeper.en.yml request_not_authorized).
const UNAUTHORIZED_INTROSPECTION = () =>
  doorkeeperError(
    400,
    "invalid_request",
    "Request need to be authorized. Required parameter for authorizing request is missing or invalid.",
  );

// GET and POST /oauth/userinfo (Mastodon's OAuth::UserinfoController; OpenID Connect Core §5.3 asks for both): the
// claims of the token's account, for a token with the profile scope. The token's account always exists while the
// token does; without it, the answer is Mastodon's for a token whose user is gone.
export const userinfo: ApiHandler = async (c, deps) => {
  const token = userCredential(c, deps);
  const claims = authorized(
    await storeCall(c, deps, (s, b) => s.userinfo(b, { credential: token, present: present(c) })),
  );
  return claims === null ? mastodonError(422, "This method requires an authenticated user") : c.json(claims);
};

// GET /.well-known/oauth-authorization-server (RFC 8414; Mastodon's OAuthMetadataSerializer, fields in its order):
// what Kopje supports of Mastodon's. The authorization endpoint answers in the query only, so the response modes are
// query alone (fragment and form_post are accepted and answered in the query: app/authorize.tsx; Mastodon's
// metadata: docs/mastodon-deviations.md, OAuth).
export const authorizationServerMetadata: ApiHandler = (c) => {
  const { origin } = present(c);
  return Promise.resolve(
    c.json({
      issuer: `${origin}/`,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      userinfo_endpoint: `${origin}/oauth/userinfo`,
      scopes_supported: SCOPES,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "client_credentials"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      code_challenge_methods_supported: ["S256"],
      service_documentation: "https://docs.joinmastodon.org/",
      // Not RFC 7591 dynamic client registration: Mastodon's own app registration, under Mastodon's name for it.
      app_registration_endpoint: `${origin}/api/v1/apps`,
    }),
  );
};
