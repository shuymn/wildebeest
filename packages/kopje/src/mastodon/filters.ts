import type {
  FilterChanges,
  FilterOutcome,
  FilterV1Changes,
  KeywordAttributes,
  KeywordChanges,
} from "../domain/filters";
import { type ApiContext, type ApiHandler, authorized, requestParams, storeCall, userCredential } from "./context";
import { mastodonError } from "./errors";
import type { Params } from "./params";

// Filters (Mastodon 4.5's Api::V2::FiltersController, Filters::KeywordsController and Filters::StatusesController, and
// the v1 layer Api::V1::FiltersController); the Store does the work (domain/filters.ts). A filter, keyword or filter
// status that is not the viewer's is not found.

const NOT_FOUND = () => mastodonError(404, "Record not found");

function outcome<T>(c: ApiContext, result: FilterOutcome<T>): Response {
  switch (result.status) {
    case "ok":
      return c.json(result.value);
    case "not_found":
      return NOT_FOUND();
    case "invalid":
      return mastodonError(422, `Validation failed: ${result.errors.join(", ")}`);
    case "refused":
      return mastodonError(422, result.error);
  }
}

function found<T>(c: ApiContext, value: T | null): Response {
  return value === null ? NOT_FOUND() : c.json(value);
}

function deleted(c: ApiContext, done: boolean): Response {
  return done ? c.json({}) : NOT_FOUND();
}

// context[] when sent (a form's empty list included), else undefined.
function context(p: Params): string[] | undefined {
  return p.has("context") ? p.getAll("context") : undefined;
}

// resource_params of Api::V2::FiltersController: title, expires_in, filter_action, context[] and keywords_attributes.
function filterChanges(p: Params): FilterChanges & { keywords: KeywordAttributes[] } {
  return {
    title: p.get("title"),
    context: context(p),
    filterAction: p.get("filter_action"),
    expiresIn: p.get("expires_in"),
    keywords: p.objects("keywords_attributes").map((entry) => ({
      id: entry.id,
      keyword: entry.keyword,
      wholeWord: entry.whole_word,
      destroy: entry._destroy,
    })),
  };
}

function keywordChanges(p: Params): KeywordChanges {
  return { keyword: p.get("keyword"), wholeWord: p.get("whole_word") };
}

// resource_params of Api::V1::FiltersController.
function v1Changes(p: Params): FilterV1Changes {
  return {
    phrase: p.get("phrase"),
    context: context(p),
    irreversible: p.get("irreversible"),
    wholeWord: p.get("whole_word"),
    expiresIn: p.get("expires_in"),
  };
}

function id(c: ApiContext, name = "id"): string {
  return c.req.param(name) ?? "";
}

export const listFilters: ApiHandler = async (c, deps) => {
  const credential = userCredential(c, deps);
  return c.json(authorized(await storeCall(c, deps, (s, b) => s.listFilters(b, { credential }))));
};

export const getFilter: ApiHandler = async (c, deps) => {
  const input = { credential: userCredential(c, deps), id: id(c) };
  return found(c, authorized(await storeCall(c, deps, (s, b) => s.getFilter(b, input))));
};

export const createFilter: ApiHandler = async (c, deps) => {
  const p = await requestParams(c, deps);
  if (p instanceof Response) {
    return p;
  }
  const input = { ...filterChanges(p), credential: userCredential(c, deps) };
  return outcome(c, authorized(await storeCall(c, deps, (s, b) => s.createFilter(b, input))));
};

export const updateFilter: ApiHandler = async (c, deps) => {
  const p = await requestParams(c, deps);
  if (p instanceof Response) {
    return p;
  }
  const input = { ...filterChanges(p), credential: userCredential(c, deps), id: id(c) };
  return outcome(c, authorized(await storeCall(c, deps, (s, b) => s.updateFilter(b, input))));
};

export const deleteFilter: ApiHandler = async (c, deps) => {
  const input = { credential: userCredential(c, deps), id: id(c) };
  return deleted(c, authorized(await storeCall(c, deps, (s, b) => s.deleteFilter(b, input))));
};

export const listFilterKeywords: ApiHandler = async (c, deps) => {
  const input = { credential: userCredential(c, deps), filterId: id(c, "filter_id") };
  return found(c, authorized(await storeCall(c, deps, (s, b) => s.listFilterKeywords(b, input))));
};

export const createFilterKeyword: ApiHandler = async (c, deps) => {
  const p = await requestParams(c, deps);
  if (p instanceof Response) {
    return p;
  }
  const input = { ...keywordChanges(p), credential: userCredential(c, deps), filterId: id(c, "filter_id") };
  return outcome(c, authorized(await storeCall(c, deps, (s, b) => s.createFilterKeyword(b, input))));
};

export const getFilterKeyword: ApiHandler = async (c, deps) => {
  const input = { credential: userCredential(c, deps), id: id(c) };
  return found(c, authorized(await storeCall(c, deps, (s, b) => s.getFilterKeyword(b, input))));
};

export const updateFilterKeyword: ApiHandler = async (c, deps) => {
  const p = await requestParams(c, deps);
  if (p instanceof Response) {
    return p;
  }
  const input = { ...keywordChanges(p), credential: userCredential(c, deps), id: id(c) };
  return outcome(c, authorized(await storeCall(c, deps, (s, b) => s.updateFilterKeyword(b, input))));
};

export const deleteFilterKeyword: ApiHandler = async (c, deps) => {
  const input = { credential: userCredential(c, deps), id: id(c) };
  return deleted(c, authorized(await storeCall(c, deps, (s, b) => s.deleteFilterKeyword(b, input))));
};

export const listFilterStatuses: ApiHandler = async (c, deps) => {
  const input = { credential: userCredential(c, deps), filterId: id(c, "filter_id") };
  return found(c, authorized(await storeCall(c, deps, (s, b) => s.listFilterStatuses(b, input))));
};

export const createFilterStatus: ApiHandler = async (c, deps) => {
  const p = await requestParams(c, deps);
  if (p instanceof Response) {
    return p;
  }
  const input = { credential: userCredential(c, deps), filterId: id(c, "filter_id"), statusId: p.get("status_id") };
  return outcome(c, authorized(await storeCall(c, deps, (s, b) => s.createFilterStatus(b, input))));
};

export const getFilterStatus: ApiHandler = async (c, deps) => {
  const input = { credential: userCredential(c, deps), id: id(c) };
  return found(c, authorized(await storeCall(c, deps, (s, b) => s.getFilterStatus(b, input))));
};

export const deleteFilterStatus: ApiHandler = async (c, deps) => {
  const input = { credential: userCredential(c, deps), id: id(c) };
  return deleted(c, authorized(await storeCall(c, deps, (s, b) => s.deleteFilterStatus(b, input))));
};

export const listFiltersV1: ApiHandler = async (c, deps) => {
  const credential = userCredential(c, deps);
  return c.json(authorized(await storeCall(c, deps, (s, b) => s.listFiltersV1(b, { credential }))));
};

export const getFilterV1: ApiHandler = async (c, deps) => {
  const input = { credential: userCredential(c, deps), id: id(c) };
  return found(c, authorized(await storeCall(c, deps, (s, b) => s.getFilterV1(b, input))));
};

export const createFilterV1: ApiHandler = async (c, deps) => {
  const p = await requestParams(c, deps);
  if (p instanceof Response) {
    return p;
  }
  const input = { ...v1Changes(p), credential: userCredential(c, deps) };
  return outcome(c, authorized(await storeCall(c, deps, (s, b) => s.createFilterV1(b, input))));
};

export const updateFilterV1: ApiHandler = async (c, deps) => {
  const p = await requestParams(c, deps);
  if (p instanceof Response) {
    return p;
  }
  const input = { ...v1Changes(p), credential: userCredential(c, deps), id: id(c) };
  return outcome(c, authorized(await storeCall(c, deps, (s, b) => s.updateFilterV1(b, input))));
};

export const deleteFilterV1: ApiHandler = async (c, deps) => {
  const input = { credential: userCredential(c, deps), id: id(c) };
  return deleted(c, authorized(await storeCall(c, deps, (s, b) => s.deleteFilterV1(b, input))));
};
