import type { FeatureResult } from "../domain/featured-tags";
import type { TagResult } from "../domain/tags";
import {
  type ApiContext,
  type ApiHandler,
  authorized,
  credential,
  optionalTokenCredential,
  present,
  requestParams,
  storeCall,
  userCredential,
} from "./context";
import { mastodonError } from "./errors";
import { pageQuery, pageResponse } from "./pagination";

// Hashtags (Mastodon 4.5's Api::V1::TagsController and FollowedTagsController) and featured hashtags
// (FeaturedTagsController, FeaturedTags::SuggestionsController and Accounts::FeaturedTagsController); the Store does the
// work (domain/tags.ts, domain/featured-tags.ts). A name that is not a hashtag answers 404, as Mastodon's.

const NOT_FOUND = () => mastodonError(404, "Record not found");

function validationError(errors: string[]): Response {
  return mastodonError(422, `Validation failed: ${errors.join(", ")}`);
}

// GET /api/v1/tags/:id.
export const getTag: ApiHandler = async (c, deps) => {
  const name = c.req.param("id") ?? "";
  const credential = optionalTokenCredential(c, deps);
  const tag = authorized(
    await storeCall(c, deps, (s, b) => s.tag(b, { credential, name, now: deps.now(), present: present(c) })),
  );
  return tag === null ? NOT_FOUND() : c.json(tag);
};

function tagResponse(c: ApiContext, result: TagResult | FeatureResult): Response {
  switch (result.status) {
    case "ok":
      return c.json(result.value);
    case "not_found":
      return NOT_FOUND();
    case "invalid":
      return validationError(result.errors);
  }
}

type TagWrite = "followTag" | "unfollowTag" | "featureTag" | "unfeatureTag";

// POST /api/v1/tags/:id/follow, /unfollow, /feature and /unfeature: the hashtag as the viewer now sees it.
function tagWrite(operation: TagWrite): ApiHandler {
  return async (c, deps) => {
    const input = {
      credential: userCredential(c, deps),
      name: c.req.param("id") ?? "",
      now: deps.now(),
      present: present(c),
    };
    return tagResponse(c, authorized(await storeCall(c, deps, (s, b) => s[operation](b, input))));
  };
}

export const followTag = tagWrite("followTag");
export const unfollowTag = tagWrite("unfollowTag");
export const featureTag = tagWrite("featureTag");
export const unfeatureTag = tagWrite("unfeatureTag");

// GET /api/v1/followed_tags: 100 hashtags by default and at most 200 (FollowedTagsController::TAGS_LIMIT,
// limit_param).
export const followedTags: ApiHandler = async (c, deps) => {
  const p = await requestParams(c, deps);
  if (p instanceof Response) {
    return p;
  }
  const page = pageQuery(p, 100, 200);
  const input = { credential: userCredential(c, deps), page, present: present(c) };
  return pageResponse(c, authorized(await storeCall(c, deps, (s, b) => s.followedTags(b, input))), page.limit);
};

// GET /api/v1/featured_tags.
export const featuredTags: ApiHandler = async (c, deps) => {
  const input = { credential: userCredential(c, deps), present: present(c) };
  return c.json(authorized(await storeCall(c, deps, (s, b) => s.listFeaturedTags(b, input))));
};

// GET /api/v1/featured_tags/suggestions.
export const featuredTagSuggestions: ApiHandler = async (c, deps) => {
  const input = { credential: userCredential(c, deps), present: present(c) };
  return c.json(authorized(await storeCall(c, deps, (s, b) => s.featuredTagSuggestions(b, input))));
};

// POST /api/v1/featured_tags: `name` is required (params.require(:name)), after the token and its user are checked.
export const createFeaturedTag: ApiHandler = async (c, deps) => {
  const p = await requestParams(c, deps);
  if (p instanceof Response) {
    return p;
  }
  const name = p.get("name") ?? "";
  if (name === "") {
    const value = credential(c, deps);
    const viewer = authorized(await storeCall(c, deps, (s, b) => s.checkCredential(b, value)));
    if (viewer.accountId === null) {
      authorized({ status: "user_required" });
    }
    return mastodonError(400, "param is missing or the value is empty: name");
  }
  const input = { credential: userCredential(c, deps), name, now: deps.now(), present: present(c) };
  return tagResponse(c, authorized(await storeCall(c, deps, (s, b) => s.createFeaturedTag(b, input))));
};

// DELETE /api/v1/featured_tags/:id: the viewer's own only; an empty object.
export const deleteFeaturedTag: ApiHandler = async (c, deps) => {
  const input = {
    credential: userCredential(c, deps),
    id: c.req.param("id") ?? "",
    now: deps.now(),
    origin: present(c).origin,
  };
  const deleted = authorized(await storeCall(c, deps, (s, b) => s.deleteFeaturedTag(b, input)));
  return deleted ? c.json({}) : NOT_FOUND();
};

// GET /api/v1/accounts/:id/featured_tags: public; 404 for an unknown account.
export const accountFeaturedTags: ApiHandler = async (c, deps) => {
  const id = c.req.param("id") ?? "";
  const tags = await storeCall(c, deps, (s, b) => s.accountFeaturedTags(b, { id, present: present(c) }));
  return tags === null ? NOT_FOUND() : c.json(tags);
};
