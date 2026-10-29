// Writes the access table of Mastodon's /api/** routes and its API routes outside /api (OUTSIDE_API), which
// test/mastodon-access.test.ts checks Kopje's route table (src/mastodon/routes.ts) against. For each route: the method,
// the path (`:param` form), the controller action, and what the action requires of the caller:
//   token   'required'  doorkeeper_authorize!, require_user!, or valid_doorkeeper_token? in the action
//           'optional'  authorize_if_got_token!, or no doorkeeper check but the controller reads the current user
//           'none'      neither: no token is read
//   scopes  the scopes doorkeeper accepts (any one of them), null when no scope is checked
//   user    require_user! or require_authenticated_user! (a token without a user is refused)
//   guards  other require_* callbacks the action runs (informative, not compared)
//   params  the request parameters the action reads (see "Request parameters" below), which
//           test/mastodon-params.test.ts checks Kopje reads
// and, for the serializers of ENTITIES, the fields they emit (see "Entity fields"), which
// test-node/mastodon-entities.test.ts checks Kopje's response types carry.
// Where the Ruby cannot be read with certainty (a conditional callback, an unknown routing statement, a controller
// not found), the route carries `unresolved` with the reasons instead of a guess.
//
// It only reads the checkout: config/routes.rb (and the files it draws), app/controllers/api/** and the controllers of
// OUTSIDE_API, the concerns they include, the model/lib constants they name, and app/serializers.
//
// On a Mastodon version bump: regenerate the fixture, review every new exception the tests that read it report
// (mastodon-access, mastodon-params, mastodon-entities), and run a Claude + Codex audit for parameters Kopje reads
// but drops or misapplies, which no test here can see.
//
//   node scripts/mastodon-scopes.mjs <mastodon checkout> [<out file>]
//   (default: test/fixtures/mastodon-<version>-api-access.json)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { escapeRegExp } from "es-toolkit";

const root = fileURLToPath(new URL("..", import.meta.url));

// ---- Ruby source helpers ----

// Lines without comments, a statement split over lines (open brackets, a trailing comma) joined into one.
/** @param {string} text */
function statements(text) {
  /** @type {{ indent: number, text: string }[]} */
  const out = [];
  let pending = "";
  let indent = 0;
  for (const line of stripComments(text).split("\n")) {
    if (pending === "") {
      if (line.trim() === "") {
        continue;
      }
      indent = line.length - line.trimStart().length;
    }
    pending = pending === "" ? line.trim() : `${pending} ${line.trim()}`;
    if (depth(pending) > 0 || pending.endsWith(",")) {
      continue;
    }
    out.push({ indent, text: pending });
    pending = "";
  }
  if (pending !== "") {
    out.push({ indent, text: pending });
  }
  return out;
}

/** @param {string} s */
function depth(s) {
  let d = 0;
  let quote = "";
  for (const ch of s) {
    if (quote !== "") {
      if (ch === quote) quote = "";
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if ("([{".includes(ch)) {
      d++;
    } else if (")]}".includes(ch)) {
      d--;
    }
  }
  return d;
}

// Splits an argument list at its top-level commas.
/** @param {string} s */
function splitArgs(s) {
  /** @type {string[]} */
  const parts = [];
  let d = 0;
  let quote = "";
  let cur = "";
  for (const ch of s) {
    if (quote !== "") {
      if (ch === quote) quote = "";
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if ("([{".includes(ch)) {
      d++;
    } else if (")]}".includes(ch)) {
      d--;
    } else if (ch === "," && d === 0) {
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== "") {
    parts.push(cur.trim());
  }
  return parts;
}

// A Ruby literal: a symbol or string as a string, an array of them as an array, anything else as { opaque }.
/** @param {string} v @returns {string | string[] | { opaque: string }} */
function literal(v) {
  const value = v.trim();
  let m = /^:'([^']*)'$|^:"([^"]*)"$|^:([\w?!]+)$|^'([^']*)'$|^"([^"]*)"$/.exec(value);
  if (m) {
    return m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "";
  }
  m = /^\[(.*)\]$/.exec(value);
  if (m) {
    const items = splitArgs(m[1] ?? "").map(literal);
    if (items.every((i) => typeof i === "string")) {
      return /** @type {string[]} */ (items);
    }
  }
  m = /^%[iw][([](.*)[)\]]$/.exec(value);
  if (m) {
    return (m[1] ?? "").trim().split(/\s+/);
  }
  return { opaque: value };
}

// Positional arguments and options of a call's argument list.
/** @param {string} s */
function callArgs(s) {
  /** @type {(string | string[] | { opaque: string })[]} */
  const positional = [];
  /** @type {Record<string, string | string[] | { opaque: string }>} */
  const options = {};
  for (const part of splitArgs(s)) {
    const m = /^(\w+):\s+(.*)$/s.exec(part) ?? /^:(\w+)\s*=>\s*(.*)$/s.exec(part);
    if (m && m[1] !== undefined && m[2] !== undefined) {
      options[m[1]] = literal(m[2]);
    } else {
      positional.push(literal(part));
    }
  }
  return { positional, options };
}

/** @param {unknown} v @returns {string[] | null} */
function list(v) {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v;
  return null;
}

/** @param {string} word */
function singular(word) {
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(ss|us|x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** @param {string} word */
function plural(word) {
  if (word.endsWith("s")) return word;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(x|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

// ---- Routes ----

const RESOURCES_ACTIONS = /** @type {const} */ ([
  ["index", ["GET"], "collection"],
  ["create", ["POST"], "collection"],
  ["new", ["GET"], "new"],
  ["edit", ["GET"], "edit"],
  ["show", ["GET"], "member"],
  ["update", ["PATCH", "PUT"], "member"],
  ["destroy", ["DELETE"], "member"],
]);
const RESOURCE_ACTIONS = /** @type {const} */ ([
  ["create", ["POST"], "self"],
  ["new", ["GET"], "new"],
  ["edit", ["GET"], "edit"],
  ["show", ["GET"], "self"],
  ["update", ["PATCH", "PUT"], "self"],
  ["destroy", ["DELETE"], "self"],
]);
const VERBS = new Set(["get", "post", "put", "patch", "delete", "match"]);

/**
 * @typedef {{ method: string, path: string, controller: string | null, action: string | null, unresolved: string[] }} RawRoute
 * @typedef {{
 *   kind: 'scope' | 'resources' | 'member' | 'collection' | 'opaque',
 *   path: string,
 *   module: string,
 *   defaults?: Record<string, unknown>,
 *   controller?: string | undefined,
 *   param?: string,
 *   unknown?: string | undefined,
 *   pendingDefaults?: RawRoute[],
 * }} Frame
 */

// Interprets the routing DSL of config/routes.rb and the files it draws. Statements outside an /api path are
// interpreted as far as needed to keep the block structure; an unknown one under /api makes its routes unresolved.
/** @param {string} checkout */
function readRoutes(checkout) {
  /** @type {RawRoute[]} */
  const routes = [];
  const main = readFileSync(join(checkout, "config", "routes.rb"), "utf8");
  const start = main.indexOf("Rails.application.routes.draw do");
  if (start < 0) {
    throw new Error("config/routes.rb: no `Rails.application.routes.draw do`");
  }
  /** @type {Frame[]} */
  const stack = [{ kind: "scope", path: "", module: "" }];
  interpret(main.slice(start).split("\n").slice(1).join("\n"), stack, routes, checkout, "config/routes.rb");
  return routes;
}

/**
 * @param {string} text
 * @param {Frame[]} stack
 * @param {RawRoute[]} routes
 * @param {string} checkout
 * @param {string} file
 */
function interpret(text, stack, routes, checkout, file) {
  const base = stack.length;
  for (const { text: stmt } of statements(text)) {
    const top = /** @type {Frame} */ (stack.at(-1));
    const head = stmt.replace(/\s*\bdo(\s*\|[^|]*\|)?$/, "");
    const opensBlock = head !== stmt;
    if (stmt === "end") {
      if (stack.length <= base) {
        // The `end` of Rails.application.routes.draw.
        return;
      }
      // A resource's own routes follow the ones of its block, as Rails draws them.
      routes.push(...(stack.pop()?.pendingDefaults ?? []));
      continue;
    }
    if (/^(if|unless|case|begin|def|class|module|while)\b/.test(stmt) && !/\bend$/.test(stmt)) {
      stack.push({ kind: "opaque", path: top.path, module: top.module, unknown: stmt });
      continue;
    }
    const m = /^(\w+)\((.*)\)$/s.exec(head) ?? /^(\w+)(?:\s+(.*))?$/s.exec(head);
    const name = m?.[1] ?? "";
    const args = callArgs(m?.[2] ?? "");
    const draw = name === "draw" ? args.positional[0] : undefined;
    if (typeof draw === "string") {
      const drawn = join(checkout, "config", "routes", `${draw}.rb`);
      interpret(readFileSync(drawn, "utf8"), stack, routes, checkout, `config/routes/${draw}.rb`);
      continue;
    }
    if (VERBS.has(name)) {
      routes.push(...verbRoutes(name, args, stack));
      continue;
    }
    const frame = enter(name, args, top, stmt);
    if (frame !== null && "defaultRoutes" in frame) {
      if (opensBlock) {
        stack.push({ ...frame.frame, pendingDefaults: frame.defaultRoutes });
      } else {
        routes.push(...frame.defaultRoutes);
      }
      continue;
    }
    if (opensBlock) {
      stack.push(frame ?? { kind: "opaque", path: top.path, module: top.module, unknown: stmt });
      continue;
    }
    if (top.path.startsWith("/api") || stmt.includes("/api")) {
      routes.push({ method: "?", path: top.path, controller: null, action: null, unresolved: [`${file}: ${stmt}`] });
    }
  }
}

/** @param {Frame[]} stack */
function inherited(stack) {
  /** @type {Record<string, unknown>} */
  const defaults = {};
  const unresolved = [];
  for (const frame of stack) {
    Object.assign(defaults, frame.defaults ?? {});
    if (frame.kind === "opaque" && frame.path.startsWith("/api")) {
      unresolved.push(`inside \`${frame.unknown}\``);
    }
  }
  return { defaults, unresolved };
}

/**
 * The frame a scoping statement opens, the default routes of a resource, or null.
 * @param {string} name
 * @param {ReturnType<typeof callArgs>} args
 * @param {Frame} top
 * @param {string} stmt
 * @returns {Frame | null | { frame: Frame, defaultRoutes: RawRoute[] }}
 */
function enter(name, args, top, stmt) {
  const first = args.positional[0];
  const { options } = args;
  const nested = nestedPath(top);
  if (name === "namespace" && typeof first === "string") {
    const path = typeof options.path === "string" ? options.path : first;
    return { kind: "scope", path: `${nested}/${path}`, module: `${top.module}${first}/` };
  }
  if (name === "scope") {
    const path = typeof options.path === "string" ? options.path : typeof first === "string" ? first : "";
    const mod = typeof options.module === "string" ? `${options.module}/` : "";
    const known = Object.keys(options).every((k) => ["path", "module", "as"].includes(k));
    return {
      kind: known ? "scope" : "opaque",
      path: path === "" ? nested : `${nested}/${path.replace(/^\//, "")}`,
      module: `${top.module}${mod}`,
      unknown: known ? undefined : stmt,
    };
  }
  if (name === "with_options") {
    return { kind: "scope", path: nested, module: top.module, defaults: options };
  }
  if (name === "member" || name === "collection") {
    if (top.kind !== "resources") {
      return { kind: "opaque", path: top.path, module: top.module, unknown: stmt };
    }
    return {
      kind: name,
      path: name === "member" ? `${top.path}/:${top.param}` : top.path,
      module: top.module,
      controller: top.controller,
    };
  }
  if ((name === "resources" || name === "resource") && typeof first === "string") {
    return resourceFrame(name === "resources", first, options, top, stmt);
  }
  return null;
}

// The path a statement nested directly in a frame starts from: under a plural resource, its :<singular>_id.
/** @param {Frame} top */
function nestedPath(top) {
  if (top.kind === "resources") {
    return `${top.path}/:${singular(top.path.split("/").at(-1) ?? "")}_${top.param ?? "id"}`;
  }
  return top.path;
}

/**
 * @param {boolean} isPlural
 * @param {string} name
 * @param {Record<string, unknown>} options
 * @param {Frame} top
 * @param {string} stmt
 */
function resourceFrame(isPlural, name, options, top, stmt) {
  const unresolved = [];
  const known = ["only", "except", "controller", "path", "param", "module", "as", "concerns", "constraints"];
  for (const key of Object.keys(options)) {
    if (!known.includes(key) || (key === "concerns" && top.path.startsWith("/api"))) {
      unresolved.push(`option ${key}: in \`${stmt}\``);
    }
  }
  const module = typeof options.module === "string" ? `${top.module}${options.module}/` : top.module;
  const segment = typeof options.path === "string" ? options.path : name;
  const path = `${nestedPath(top)}/${segment}`;
  const controllerName = typeof options.controller === "string" ? options.controller : isPlural ? name : plural(name);
  const controller = `${module}${controllerName}`;
  const param = typeof options.param === "string" ? options.param : "id";
  const table = isPlural ? RESOURCES_ACTIONS : RESOURCE_ACTIONS;
  const only = list(options.only);
  const except = list(options.except) ?? [];
  /** @type {RawRoute[]} */
  const defaultRoutes = [];
  for (const [action, methods, where] of table) {
    if ((only !== null && !only.includes(action)) || except.includes(action)) {
      continue;
    }
    const actionPath =
      where === "collection" || where === "self"
        ? path
        : where === "member"
          ? `${path}/:${param}`
          : where === "new"
            ? `${path}/new`
            : `${path}/:${param}/edit`;
    for (const method of methods) {
      defaultRoutes.push({ method, path: actionPath, controller, action, unresolved: [...unresolved] });
    }
  }
  /** @type {Frame} */
  const frame = {
    // A singular resource nests its children under its own path, as a scope.
    kind: isPlural ? "resources" : "scope",
    path,
    module,
    controller,
    param,
  };
  return { frame, defaultRoutes };
}

/**
 * @param {string} verb
 * @param {ReturnType<typeof callArgs>} args
 * @param {Frame[]} stack
 * @returns {RawRoute[]}
 */
function verbRoutes(verb, args, stack) {
  const top = /** @type {Frame} */ (stack.at(-1));
  const { defaults, unresolved } = inherited(stack);
  const options = { ...defaults, ...args.options };
  const first = args.positional[0];
  const base = nestedPath(top);
  const segment = typeof first === "string" ? first : "";
  if (typeof first !== "string") {
    unresolved.push(`path ${JSON.stringify(first)}`);
  }
  const joined = segment.startsWith("/") ? `${base}${segment}` : `${base}/${segment}`;
  let controller = null;
  let action = null;
  const to = options.to;
  if (typeof to === "string" && /^[\w/]+#[\w?!]+$/.test(to)) {
    const [c, a] = to.split("#");
    controller = `${top.module}${c}`;
    action = a ?? null;
  } else if (to === undefined && (top.kind === "member" || top.kind === "collection" || top.kind === "resources")) {
    controller = top.controller ?? null;
    action = segment;
  } else {
    unresolved.push(`target ${JSON.stringify(to ?? null)}`);
  }
  let methods = [verb.toUpperCase()];
  if (verb === "match") {
    const via = list(options.via);
    methods = via === null ? ["?"] : via.map((v) => v.toUpperCase());
    if (via === null) unresolved.push("match without via:");
  }
  // An optional segment `(...)` is written as present.
  const path = joined
    .replace(/\(([^)]*)\)/g, "$1")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
  return methods.map((method) => ({ method, path, controller, action, unresolved: [...unresolved] }));
}

// ---- Controllers ----

/**
 * @typedef {{
 *   file: string,
 *   callback: string,
 *   args: string,
 *   only: string[] | null,
 *   except: string[] | null,
 *   conditional: string | null,
 *   conditions: string[],
 *   nested: boolean,
 *   skip: boolean,
 *   after: boolean,
 *   unreadable: string | null,
 * }} Callback
 * @typedef {{ callbacks: Callback[], unresolved: string[], chain: string[] }} Controller
 */

const TRACKED = new Set([
  "doorkeeper_authorize!",
  "authorize_if_got_token!",
  "require_user!",
  "require_authenticated_user!",
]);
const API_BASE = "Api::BaseController";

/** @param {string} className */
function classFile(className) {
  return `app/controllers/${className
    .split("::")
    .map((part) => part.replace(/([a-z\d])([A-Z])/g, "$1_$2").toLowerCase())
    .join("/")}.rb`;
}

/**
 * @param {string} checkout
 * @param {string} file relative to the checkout
 * @param {Map<string, Controller | null>} cache
 * @returns {Controller | null}
 */
function readController(checkout, file, cache) {
  if (cache.has(file)) {
    return cache.get(file) ?? null;
  }
  cache.set(file, null);
  const path = join(checkout, file);
  if (!existsSync(path)) {
    return null;
  }
  const text = readFileSync(path, "utf8");
  const unresolved = [];
  const klass = /^class\s+([\w:]+)\s*<\s*([\w:]+)/m.exec(text);
  /** @type {Controller} */
  let parent = { callbacks: [], unresolved: [], chain: [] };
  if (klass === null) {
    unresolved.push(`${file}: no class declaration`);
  } else if (klass[1] !== API_BASE && klass[2] !== "ApplicationController") {
    const parentFile = classFile(/** @type {string} */ (klass[2]));
    const read = readController(checkout, parentFile, cache);
    if (read === null) {
      unresolved.push(`${file}: parent ${klass[2]} not found`);
    } else {
      parent = read;
    }
  }
  for (const mod of text.matchAll(/^\s*include\s+([\w:]+)/gm)) {
    const concern = join(
      checkout,
      classFile(/** @type {string} */ (mod[1])).replace("app/controllers/", "app/controllers/concerns/"),
    );
    if (
      existsSync(concern) &&
      /doorkeeper_authorize!|authorize_if_got_token!|require_user!/.test(readFileSync(concern, "utf8"))
    ) {
      unresolved.push(`${file}: concern ${mod[1]} checks access`);
    }
  }
  /** @type {Callback[]} */
  const callbacks = [];
  let classIndent = null;
  for (const { indent, text: stmt } of statements(text)) {
    if (/^class\b/.test(stmt) && classIndent === null) {
      classIndent = indent + 2;
      continue;
    }
    const m = /^(prepend_before_action|before_action|skip_before_action|after_action)\s+(.*)$/s.exec(stmt);
    if (m === null) {
      continue;
    }
    const skip = m[1] === "skip_before_action";
    const after = m[1] === "after_action";
    const parts = splitArgs(/** @type {string} */ (m[2]));
    const target = parts[0] ?? "";
    let callback = "";
    let cbArgs = "";
    const lambda = /^->\s*\{\s*([\w!?]+)\s*(.*?)\s*\}$/s.exec(target);
    if (lambda) {
      callback = /** @type {string} */ (lambda[1]);
      cbArgs = /** @type {string} */ (lambda[2]);
    } else if (/^:[\w!?]+$/.test(target)) {
      callback = target.slice(1);
    } else {
      // Any form that may check a token, a user or a Pundit policy; the tracked names alone would miss `authorize`.
      if (/doorkeeper|authorize|require_user|require_authenticated_user/.test(target)) {
        unresolved.push(`${file}: callback \`${stmt}\``);
      }
      continue;
    }
    const { options } = callArgs(parts.slice(1).join(", "));
    const conditionKeys = Object.keys(options).filter((k) => k === "if" || k === "unless");
    const conditional =
      conditionKeys.length > 0 ? conditionKeys.map((k) => `${k}: ${JSON.stringify(options[k])}`).join(", ") : null;
    callbacks.push({
      callback,
      args: cbArgs,
      only: options.only === undefined ? null : list(options.only),
      except: options.except === undefined ? null : list(options.except),
      // only:/except: literal() cannot read (a constant, an expression): the actions it runs for are unknown.
      unreadable: [options.only, options.except].some((v) => v !== undefined && list(v) === null) ? stmt : null,
      conditional,
      // The methods an if:/unless: names; they run (and read parameters) whenever the callback is considered.
      conditions: conditionKeys.flatMap((k) => list(options[k]) ?? []),
      nested: classIndent !== null && indent > classIndent,
      file,
      skip,
      after,
    });
  }
  const controller = {
    callbacks: [...parent.callbacks, ...callbacks],
    unresolved: [...parent.unresolved, ...unresolved],
    chain: [...parent.chain, file],
  };
  cache.set(file, controller);
  return controller;
}

/** @param {Callback} cb @param {string} action */
function applies(cb, action) {
  if (cb.only !== null && !cb.only.includes(action)) return false;
  if (cb.except !== null && cb.except.includes(action)) return false;
  return true;
}

// The body of `def <action>` up to the next definition or visibility keyword.
/** @param {string} text @param {string} action */
function actionBody(text, action) {
  const start = text.search(new RegExp(`^[ \\t]*def ${escapeRegExp(action)}(?![\\w?!])`, "m"));
  if (start < 0) return null;
  const rest = text.slice(start);
  const firstLine = rest.indexOf("\n") + 1;
  const next = rest.slice(firstLine).search(/^[ \t]*(def |private\b|protected\b)/m);
  return next < 0 ? rest : rest.slice(0, firstLine + next);
}

// The last definition of a method in a controller chain (a subclass's overrides its parent's).
/** @param {string[]} texts @param {string} name */
function methodBody(texts, name) {
  return texts.map((t) => actionBody(t, name)).findLast((b) => b !== null) ?? null;
}

/**
 * @param {RawRoute} route
 * @param {string} checkout
 * @param {Map<string, Controller | null>} cache
 */
function access(route, checkout, cache) {
  const unresolved = [...route.unresolved];
  const entry = {
    method: route.method,
    path: route.path,
    controller: route.controller,
    action: route.action,
  };
  if (route.controller === null || route.action === null) {
    return { ...entry, token: null, scopes: null, user: null, unresolved };
  }
  const file = `app/controllers/${route.controller}_controller.rb`;
  const controller = readController(checkout, file, cache);
  if (controller === null) {
    unresolved.push(`${file} not found`);
    return { ...entry, token: null, scopes: null, user: null, unresolved };
  }
  unresolved.push(...controller.unresolved);
  const action = route.action;
  /** @type {Callback[]} */
  const active = [];
  for (const cb of controller.callbacks) {
    if (cb.unreadable !== null) {
      unresolved.push(`unreadable only:/except: in \`${cb.unreadable}\``);
      continue;
    }
    if (!applies(cb, action)) continue;
    if (cb.skip) {
      for (let i = active.length - 1; i >= 0; i--) {
        if (active[i]?.callback !== cb.callback) continue;
        if (cb.conditional !== null) unresolved.push(`skip_before_action ${cb.callback} ${cb.conditional}`);
        active.splice(i, 1);
      }
      continue;
    }
    // Api::BaseController's gate for instances that close the API to anonymous callers (instance configuration).
    if (
      cb.callback === "require_authenticated_user!" &&
      cb.conditional?.includes("disallow_unauthenticated_api_access?")
    ) {
      continue;
    }
    active.push(cb);
  }
  for (const cb of active) {
    if (TRACKED.has(cb.callback) && (cb.conditional !== null || cb.nested)) {
      unresolved.push(`${cb.callback} ${cb.conditional ?? "inside a block"}`);
    }
  }
  const checks = active.filter(
    (cb) => cb.callback === "doorkeeper_authorize!" || cb.callback === "authorize_if_got_token!",
  );
  if (checks.length > 1) {
    unresolved.push(`${checks.length} scope checks`);
  }
  const check = checks[0];
  let scopes = null;
  if (check !== undefined) {
    const parsed = callArgs(check.args).positional;
    if (parsed.length === 0 || parsed.some((s) => typeof s !== "string")) {
      unresolved.push(`scopes of ${check.callback} ${check.args}`);
    } else {
      scopes = /** @type {string[]} */ (parsed).toSorted();
    }
  }
  const user = active.some((cb) => cb.callback === "require_user!" || cb.callback === "require_authenticated_user!");
  const texts = controller.chain
    .filter((f) => f !== classFile(API_BASE))
    .map((f) => readFileSync(join(checkout, f), "utf8"));
  const body = methodBody(texts, action);
  if (body === null && !/^(index|show|create|update|destroy)$/.test(action)) {
    unresolved.push(`no def ${action} in ${file}`);
  }
  const validToken = body !== null && /valid_doorkeeper_token\?/.test(body);
  // A Pundit policy (authorize in the action or in a callback it runs, or verify_authorized after it) decides on the
  // viewer in Ruby this script does not read: unless a user is required anyway, the route is not resolved.
  const policies = [body, ...active.filter((cb) => !cb.after).map((cb) => methodBody(texts, cb.callback))]
    .flatMap((b) => b?.match(/\bauthorize(?:_with)?[ (][^\n]*/g) ?? [])
    .map((call) => call.trim());
  if (active.some((cb) => cb.after && cb.callback === "verify_authorized")) {
    policies.push("verify_authorized");
  }
  if (!user && policies.length > 0) {
    unresolved.push(`Pundit policy: ${[...new Set(policies)].join("; ")}`);
  }
  // Api::BaseController reads the current user in every request; whether an action uses it is in its own chain. A
  // controller that overrides current_user to read it only in limited federation mode reads no user.
  const overrides = texts.map((t) => actionBody(t, "current_user")).filter((b) => b !== null);
  if (overrides.some((b) => !/^\s*def current_user\s+super if limited_federation_mode\?\s+end\s*$/.test(b))) {
    unresolved.push("current_user overridden");
  }
  const readsUser =
    overrides.length === 0 && texts.some((t) => /\bcurrent_(user|account)\b|\buser_signed_in\?/.test(t));
  let token;
  if (check?.callback === "doorkeeper_authorize!") {
    token = "required";
  } else if (check?.callback === "authorize_if_got_token!") {
    token = user ? "required" : "optional";
  } else if (user || validToken) {
    token = "required";
  } else {
    token = readsUser ? "optional" : "none";
  }
  const guards = [
    ...new Set(
      active
        .filter((cb) => cb.callback.startsWith("require_") && !TRACKED.has(cb.callback))
        .filter((cb) => !cb.after && cb.file !== classFile(API_BASE))
        .map((cb) => cb.callback),
    ),
  ];
  return {
    ...entry,
    token,
    scopes,
    user,
    ...(guards.length > 0 ? { guards } : {}),
    ...(unresolved.length > 0 ? { unresolved } : {}),
  };
}

// ---- Request parameters ----

// The request parameters an action reads, in Kopje's Params form (`a`, `a[]`, `a[b]`, `a[][b]`). Read from the
// action's body, the before_action callbacks (and their if:/unless: conditions) that apply to it, and the methods they
// call by name, defined in the controller chain or the concerns it includes, followed transitively. after_action
// callbacks (pagination links echo parameters, they do not apply them) are not followed.
//
// Supported forms: params.permit / params.slice(...).permit / params.require(:x)[.permit] / params.expect,
// params[:x] (nested params[:x][:y]), params.fetch / key? / include? / dig / slice, truthy_param?(:x), limit_param
// (`limit`), params_slice(:a, ...), a local alias of params.require(:x) or params[:x] read with fetch / [] / key?, and
// constants holding a literal list (or the keys of a literal hash). Anything else that touches params is listed in
// `unresolved` with the reason, never guessed.

const RAILS_KEYS = new Set(["controller", "action", "format"]);

// Helpers whose reads are known (their bodies are not followed): the names they read are taken from their arguments.
const PARAM_HELPERS = new Set(["truthy_param?", "limit_param", "params_slice"]);

const VALUE_METHODS = new Set([
  "present?",
  "blank?",
  "presence",
  "nil?",
  "to_i",
  "to_s",
  "to_sym",
  "downcase",
  "strip",
  "split",
  "==",
]);

// Wire shape of permit(c: [:d, ...]): Rails permits both a hash and an array of hashes there; the shape is the one the
// consuming code reads. Keyed by `<file> <key>`.
/** @type {Record<string, 'object' | 'array'>} */
const PERMIT_SHAPES = {
  // Account#fields_attributes= (app/models/account.rb) takes a list of name/value records; clients send an array or
  // an indexed hash, both an array of records.
  "app/controllers/api/v1/accounts/credentials_controller.rb fields_attributes": "array",
  // UpdateStatusService#update_media_attachments! iterates media_attributes as a list of records.
  "app/controllers/api/v1/statuses_controller.rb media_attributes": "array",
  // PostStatusService / UpdateStatusService read poll as one record (options, expires_in, multiple, hide_totals).
  "app/controllers/api/v1/statuses_controller.rb poll": "object",
  // CustomFilter accepts_nested_attributes_for :keywords: a list of keyword records.
  "app/controllers/api/v2/filters_controller.rb keywords_attributes": "array",
};

// Reviewed readings of expressions the extraction cannot read alone, keyed by the unresolved reason it would give. The
// names come from a constant's literal list (with `member` appended to each, for records), so a change of the list
// changes them; a constant that is no longer a literal list leaves the reason unresolved.
/** @type {Record<string, { constant: string, member?: string }>} */
const PARAM_READINGS = {
  // resource_params.each_pair: one record per timeline of Marker::TIMELINES (app/models/marker.rb), each with
  // last_read_id.
  "app/controllers/api/v1/markers_controller.rb resource_params: unreadable `*Marker::TIMELINES.map { |timeline| { timeline.to_sym => [:last_read_id] } }`":
    { constant: "Marker::TIMELINES", member: "last_read_id" },
  // AccountStatusesFilter (app/lib/account_statuses_filter.rb) reads its KEYS from the params it is given.
  "app/controllers/api/v1/accounts/statuses_controller.rb preloaded_account_statuses: params used whole `params).results,`":
    { constant: "AccountStatusesFilter::KEYS" },
};

// params[:x] whose value the consuming code reads as an array (clients send `x[]`), keyed by `<file> <x>`.
const ARRAY_VALUES = new Set([
  // Admin::Metrics::Measure.retrieve / Dimension.retrieve iterate the keys.
  "app/controllers/api/v1/admin/measures_controller.rb keys",
  "app/controllers/api/v1/admin/dimensions_controller.rb keys",
  // TagFeed#tags_for(Array(...)).
  "app/controllers/api/v1/timelines/tag_controller.rb any",
  "app/controllers/api/v1/timelines/tag_controller.rb all",
  "app/controllers/api/v1/timelines/tag_controller.rb none",
  // VoteService takes the choices as a list.
  "app/controllers/api/v1/polls/votes_controller.rb choices",
  // FollowService's languages: a list of language codes.
  "app/controllers/api/v1/accounts_controller.rb languages",
]);

/** @param {string} text */
function stripComments(text) {
  return text
    .split("\n")
    .map((raw) => raw.replace(/\s+#(?![{]).*$/, "").replace(/^\s*#.*$/, ""))
    .join("\n");
}

// The index after the bracket that closes the one at `start`.
/** @param {string} text @param {number} start */
function closing(text, start) {
  let d = 0;
  let quote = "";
  for (let i = start; i < text.length; i++) {
    const ch = /** @type {string} */ (text[i]);
    if (quote !== "") {
      if (ch === quote) quote = "";
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if ("([{".includes(ch)) {
      d++;
    } else if (")]}".includes(ch)) {
      d--;
      if (d === 0) return i + 1;
    }
  }
  return -1;
}

/** @param {string[]} path */
const paramName = (path) =>
  `${path[0]}${path
    .slice(1)
    .map((s) => `[${s}]`)
    .join("")}`;

/**
 * @typedef {{ file: string, text: string }} Source
 * @typedef {{
 *   names: Set<string>,
 *   unresolved: string[],
 *   calls: { name: string, paths: string[][] | null }[],
 *   root: string[],
 * }} Reads
 */

// The files whose methods an action can call, lowest precedence first: for each class of the chain (base first), the
// concerns it includes, then the class itself.
/** @param {string} checkout @param {string[]} chain */
function methodSources(checkout, chain) {
  /** @type {Source[]} */
  const sources = [];
  const seen = new Set();
  /** @param {string} file */
  const add = (file) => {
    if (seen.has(file) || !existsSync(join(checkout, file))) return;
    seen.add(file);
    const text = stripComments(readFileSync(join(checkout, file), "utf8"));
    for (const mod of text.matchAll(/^\s*include\s+([\w:]+)/gm)) {
      add(classFile(/** @type {string} */ (mod[1])).replace("app/controllers/", "app/controllers/concerns/"));
    }
    sources.push({ file, text });
  };
  for (const file of chain) add(file);
  return sources;
}

/** @param {Source[]} sources @param {string} name @returns {{ file: string, body: string } | null} */
function findMethod(sources, name) {
  for (const source of sources.toReversed()) {
    const body = actionBody(source.text, name);
    if (body !== null) return { file: source.file, body: body.slice(body.indexOf("\n") + 1) };
  }
  return null;
}

// A constant's literal list: `NAME = %i(...)` / `[...]`, or `NAME = HASH.keys` of a literal hash constant. `Mod::NAME`
// is looked up in app/models or app/lib, a bare NAME in the controller's sources.
/** @param {string} expr @param {Source[]} sources @param {string} checkout @returns {string[] | null} */
function constantList(expr, sources, checkout) {
  const m = /^(?:([\w:]+)::)?([A-Z][A-Z0-9_]*)$/.exec(expr.trim());
  if (m === null) return null;
  const [, mod, name] = m;
  const texts =
    mod === undefined
      ? sources.map((s) => s.text)
      : ["app/models", "app/lib"]
          .map((dir) => classFile(/** @type {string} */ (mod)).replace("app/controllers", dir))
          .filter((file) => existsSync(join(checkout, file)))
          .map((file) => stripComments(readFileSync(join(checkout, file), "utf8")));
  /** @param {string} constName @returns {string | null} */
  const valueOf = (constName) => {
    for (const text of texts.toReversed()) {
      for (const { text: stmt } of statements(text)) {
        const def = new RegExp(`^${constName}\\s*=\\s*(.*?)(?:\\.freeze)?$`, "s").exec(stmt);
        if (def) return /** @type {string} */ (def[1]);
      }
    }
    return null;
  };
  const value = valueOf(/** @type {string} */ (name));
  if (value === null) return null;
  const read = literal(value);
  if (Array.isArray(read)) return read;
  const keysOf = /^([A-Z][A-Z0-9_]*)\.keys$/.exec(value);
  const hash = keysOf === null ? null : valueOf(/** @type {string} */ (keysOf[1]));
  const inner = hash === null ? null : /^\{(.*)\}$/s.exec(hash)?.[1];
  if (inner === undefined || inner === null) return null;
  /** @type {string[]} */
  const keys = [];
  for (const part of splitArgs(inner)) {
    const key = /^(\w+):\s/.exec(part)?.[1] ?? /^'([^']+)':\s/.exec(part)?.[1] ?? /^"([^"]+)":\s/.exec(part)?.[1];
    if (key === undefined) return null;
    keys.push(key);
  }
  return keys;
}

/**
 * The names of a permit()/expect() argument list under `prefix`.
 * @param {string} args
 * @param {string[]} prefix
 * @param {'permit' | 'expect'} mode
 * @param {{ file: string, sources: Source[], checkout: string, unresolved: (reason: string) => void }} ctx
 * @returns {string[]}
 */
function permitNames(args, prefix, mode, ctx) {
  /** @type {string[]} */
  const names = [];
  for (const part of splitArgs(args)) {
    const scalar = literal(part);
    if (typeof scalar === "string") {
      names.push(paramName([...prefix, scalar]));
      continue;
    }
    const splat = /^\*(.+)$/.exec(part);
    if (splat) {
      const list = constantList(/** @type {string} */ (splat[1]), ctx.sources, ctx.checkout);
      if (list === null) {
        ctx.unresolved(`unreadable \`${part}\``);
      } else {
        names.push(...list.map((n) => paramName([...prefix, n])));
      }
      continue;
    }
    const hash = /^\{(.*)\}$/s.exec(part);
    if (hash) {
      names.push(...permitNames(/** @type {string} */ (hash[1]), prefix, mode, ctx));
      continue;
    }
    const pair =
      /^(\w+):\s*(.*)$/s.exec(part) ?? /^:(\w+)\s*=>\s*(.*)$/s.exec(part) ?? /^'([^']+)':\s*(.*)$/s.exec(part);
    if (pair === null) {
      ctx.unresolved(`unreadable \`${part}\``);
      continue;
    }
    const key = /** @type {string} */ (pair[1]);
    const value = /** @type {string} */ (pair[2]).trim();
    if (value === "[]") {
      names.push(`${paramName([...prefix, key])}[]`);
      continue;
    }
    if (value === "{}") {
      ctx.unresolved(`any hash \`${part}\``);
      continue;
    }
    /** @type {string | null} */
    let members = /^\[(.*)\]$/s.exec(value)?.[1] ?? null;
    let shape = /** @type {'object' | 'array' | undefined} */ (undefined);
    if (members !== null && mode === "expect" && /^\[(.*)\]$/s.test(members.trim())) {
      // expect(x: [[:a]]): an array of records.
      members = /** @type {string} */ (/^\[(.*)\]$/s.exec(members.trim())?.[1]);
      shape = "array";
    }
    if (members === null) {
      const list = constantList(value, ctx.sources, ctx.checkout);
      members = list === null ? null : list.map((n) => `'${n}'`).join(", ");
    }
    if (members === null) {
      ctx.unresolved(`unreadable \`${part}\``);
      continue;
    }
    shape ??= mode === "expect" ? "object" : PERMIT_SHAPES[`${ctx.file} ${key}`];
    if (shape === undefined) {
      ctx.unresolved(`shape of \`${key}:\` (a record or a list of records: add it to PERMIT_SHAPES)`);
      continue;
    }
    names.push(...permitNames(members, shape === "object" ? [...prefix, key] : [...prefix, key, ""], mode, ctx));
  }
  return names;
}

// The values a block variable takes at `offset`. Every `<collection>.each do |...|` or `{ |...| }` whose block encloses
// the offset and binds the name is a candidate; the innermost decides. Null when none binds it or when the innermost
// one's collection is not a literal list.
/** @param {string} body @param {string} variable @param {number} offset */
function loopValues(body, variable, offset) {
  if (!/^[a-z_]\w*$/.test(variable)) return null;
  // Every `.each` block counts, whatever precedes it; a collection that is not a literal list (or not one of these
  // simple forms, as `x.select { ... }.each`) leaves the read unresolved.
  const loops = /(%[iw]\([^)]*\)|\[[^\]]*\]|[\w:.]+)?\.each\s*(do\s*|\{\s*)\|([^|]*)\|/g;
  /** @type {{ start: number, collection: string | undefined } | null} */
  let innermost = null;
  for (const m of body.matchAll(loops)) {
    const names = /** @type {string} */ (m[3]).split(",").map((v) => v.trim());
    if (!names.includes(variable)) continue;
    const start = m.index + m[0].length;
    let end;
    if (/** @type {string} */ (m[2]).startsWith("{")) {
      end = closing(body, m.index + m[0].lastIndexOf("{"));
    } else {
      // A do block ends at the `end` indented as the line that opens it.
      const lineStart = body.lastIndexOf("\n", m.index) + 1;
      const indent = /^[ \t]*/.exec(body.slice(lineStart))?.[0] ?? "";
      const close = new RegExp(`^${indent}end\\b`, "m").exec(body.slice(start));
      end = close === null ? -1 : start + close.index;
    }
    if (end >= 0 && start <= offset && offset < end && (innermost === null || start > innermost.start)) {
      innermost = { start, collection: m[1] };
    }
  }
  const list = innermost?.collection === undefined ? null : literal(innermost.collection);
  return Array.isArray(list) ? list : null;
}

/**
 * The parameters one method body reads, and the methods it calls.
 * @param {string} body
 * @param {string} where `<file> <method>`, for reasons
 * @param {string} file
 * @param {Source[]} sources
 * @param {string} checkout
 * @returns {Reads}
 */
function bodyReads(body, where, file, sources, checkout) {
  /** @type {Reads} */
  const reads = { names: new Set(), unresolved: [], calls: [], root: [] };
  /** @param {string} reason */
  const unresolved = (reason) => {
    const key = `${where}: ${reason}`;
    const reading = PARAM_READINGS[key];
    const list = reading === undefined ? null : constantList(reading.constant, sources, checkout);
    const names =
      list === null ? null : list.map((v) => (reading?.member === undefined ? v : `${v}[${reading.member}]`));
    if (names === null) {
      reads.unresolved.push(key);
    } else {
      for (const name of names) reads.names.add(name);
    }
  };
  const ctx = { file, sources, checkout, unresolved };
  let listContext = false;
  /** @param {string[]} path */
  const record = (path) => {
    const array = path.length === 1 && (listContext || ARRAY_VALUES.has(`${file} ${path[0]}`));
    reads.names.add(array ? `${paramName(path)}[]` : paramName(path));
  };
  /** @type {Map<string, string[]>} */
  const aliases = new Map();

  // Reads the chain after a root (params, or an alias standing for `start`) that ends at `at`. Returns the path when
  // the chain is assigned and ends at a container (an alias), else records what it reads.
  // `from` is where the expression starts, for reasons.
  /**
   * @param {number} at
   * @param {string[]} start
   * @param {string} root
   * @param {boolean} assigned
   * @param {number} from
   * @returns {string[] | undefined}
   */
  const chain = (at, start, root, assigned, from = at - root.length) => {
    const eol = body.indexOf("\n", at);
    /** @param {string} reason */
    const fail = (reason) => unresolved(`${reason} \`${body.slice(from, eol < 0 ? body.length : eol).trim()}\``);
    const path = [...start];
    let i = at;
    for (;;) {
      if (body[i] === "[") {
        const end = closing(body, i);
        const key = literal(body.slice(i + 1, end - 1));
        if (typeof key !== "string") {
          // params[v] in `<literal list>.each do |v|`: the chain read once per value of the list.
          const values = path.length === 0 ? loopValues(body, body.slice(i + 1, end - 1).trim(), i) : null;
          if (values === null) {
            unresolved(`dynamic key \`${body.slice(from, end).trim()}\``);
          } else {
            for (const value of values) chain(end, [value], root, false, from);
          }
          return undefined;
        }
        path.push(key);
        i = end;
        continue;
      }
      const call = /^\s*\.(\w+[?!]?)/.exec(body.slice(i));
      if (call === null) {
        if (path.length === 0) {
          fail("params used whole");
          return undefined;
        }
        if (assigned) {
          return path;
        }
        record(path);
        return undefined;
      }
      const method = /** @type {string} */ (call[1]);
      const open = i + call[0].length;
      const args = body[open] === "(" ? body.slice(open + 1, closing(body, open) - 1) : null;
      const next = args === null ? open : closing(body, open);
      if (method === "permit" || method === "expect") {
        if (args === null) {
          fail(`${method} without arguments`);
          return undefined;
        }
        for (const name of permitNames(args, path, method, ctx)) reads.names.add(name);
        // The value is the required record (params.require(:x).permit, params.expect(x: [...])): keys read of it
        // are under x.
        const parts = splitArgs(args);
        const only = parts.length === 1 ? /^(\w+):\s*\[/.exec(parts[0] ?? "")?.[1] : undefined;
        reads.root = method === "expect" && only !== undefined ? [...path, only] : path;
        return undefined;
      }
      if (method === "require") {
        const key = args === null ? null : literal(args);
        if (typeof key !== "string") {
          fail("unreadable require");
          return undefined;
        }
        path.push(key);
        i = next;
        continue;
      }
      if (method === "slice") {
        if (/^\s*\.permit\b/.test(body.slice(next))) {
          i = next;
          continue;
        }
        const keys = args === null ? [] : permitNames(args, path, "permit", ctx);
        for (const name of keys) reads.names.add(name);
        return undefined;
      }
      if (["fetch", "key?", "include?", "has_key?", "dig"].includes(method)) {
        const keys = args === null ? [] : splitArgs(args).map(literal);
        const take = method === "dig" ? keys : keys.slice(0, 1);
        if (take.length === 0 || take.some((k) => typeof k !== "string")) {
          fail(`unreadable ${method}`);
        } else {
          record([...path, .../** @type {string[]} */ (take)]);
        }
        return undefined;
      }
      if (path.length > start.length || (path.length > 0 && VALUE_METHODS.has(method))) {
        record(path);
        return undefined;
      }
      fail(`unsupported .${method}`);
      return undefined;
    }
  };

  for (const m of body.matchAll(/(?<![\w.:@$])params\b(?![?!:])/g)) {
    const before = body.slice(body.lastIndexOf("\n", m.index) + 1, m.index);
    // Array(params[:x]): a list (clients send `x[]`).
    listContext = /\bArray\(\s*$/.test(before);
    const assign = /(\w+)\s*(?:\|\|)?=\s*$/.exec(before);
    const path = chain(m.index + "params".length, [], "params", assign !== null);
    if (assign !== null && path !== undefined) {
      aliases.set(/** @type {string} */ (assign[1]), path);
    }
  }
  listContext = false;
  for (const [alias, path] of aliases) {
    const uses = [
      ...body.matchAll(new RegExp(`(?<![\\w.:@$])${escapeRegExp(alias)}\\b(?![?!:]|\\s*(?:\\|\\|)?=[^=])`, "g")),
    ];
    for (const m of uses) chain(m.index + alias.length, path, alias, false);
    if (uses.length === 0) record(path);
  }
  // The helpers: limit_param reads `limit` whatever its arguments; truthy_param? and params_slice read the names
  // their arguments give, which must be symbol or string literals.
  for (const m of body.matchAll(/(?<![\w.:@$])(truthy_param\?|limit_param|params_slice)(?![\w?!])/g)) {
    const helper = /** @type {string} */ (m[1]);
    if (helper === "limit_param") {
      reads.names.add("limit");
      continue;
    }
    const at = m.index + helper.length;
    const open = /^\s*\(/.exec(body.slice(at));
    const args = open
      ? body.slice(at + open[0].length, closing(body, at + open[0].length - 1) - 1)
      : (/^[ \t]+([^\n]*)/.exec(body.slice(at))?.[1] ?? "");
    const parts = splitArgs(args);
    const taken = helper === "truthy_param?" ? parts.slice(0, 1) : parts;
    const keys = taken.map(literal);
    if (taken.length === 0 || keys.some((k) => typeof k !== "string")) {
      unresolved(`unreadable \`${helper}${open ? `(${args})` : ` ${args}`}\``);
      continue;
    }
    for (const key of /** @type {string[]} */ (keys)) record([key]);
  }
  const locals = new Set([
    ...[...body.matchAll(/(?<![\w.:@$])(\w+)\s*(?:\|\|)?=(?![=~>])/g)].map((m) => m[1]),
    // Block parameters: `do |timeline, timeline_params|`.
    ...[...body.matchAll(/\|([\w\s,*]+)\|/g)].flatMap((m) =>
      (m[1] ?? "").split(",").map((v) => v.trim().replace(/^\*/, "")),
    ),
  ]);
  /** @type {Map<string, string[][] | null>} */
  const calls = new Map();
  for (const m of body.matchAll(/(?<![\w.:@$])([a-z_]\w*[?!]?)(?!:(?!:))/g)) {
    const name = /** @type {string} */ (m[1]);
    if (name === "params" || PARAM_HELPERS.has(name) || locals.has(name)) continue;
    const paths = accessPaths(body, m.index + name.length);
    const known = calls.get(name);
    calls.set(name, known === null || paths === null ? null : [...(known ?? []), ...paths]);
  }
  reads.calls = [...calls].map(([name, paths]) => ({ name, paths }));
  return reads;
}

// The keys read of a value at `at` (a method that returns permitted params): `x[:a][:b]`, `x.fetch(:a)`, `x.dig(:a)`,
// `x.key?(:a)`, `x.slice(:a, :b)`; null when the value is used whole.
/** @param {string} body @param {number} at @returns {string[][] | null} */
function accessPaths(body, at) {
  /** @type {string[]} */
  const path = [];
  let i = at;
  while (body[i] === "[") {
    const end = closing(body, i);
    const key = literal(body.slice(i + 1, end - 1));
    if (typeof key !== "string") return null;
    path.push(key);
    i = end;
  }
  if (path.length > 0) return [path];
  const call = /^\.(fetch|dig|key\?|slice)\(([^()]*)\)/.exec(body.slice(i));
  if (call === null) return null;
  const keys = splitArgs(/** @type {string} */ (call[2])).map(literal);
  if (keys.some((k) => typeof k !== "string")) return null;
  const strings = /** @type {string[]} */ (keys);
  if (call[1] === "slice") return strings.map((k) => [k]);
  return [call[1] === "dig" ? strings : strings.slice(0, 1)];
}

// A name's segments: `a[b][]` is a, b, ''.
/** @param {string} name */
const segments = (name) => [
  /** @type {string} */ (/^[^[]+/.exec(name)?.[0]),
  ...[...name.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1] ?? ""),
];

// before_action callbacks whose reads an action does not use, keyed by `<file> <callback>`: the actions.
/** @type {Record<string, string[]>} */
const DISCARDED_CALLBACKS = {
  // The admin trend reviews inherit Api::V1::Trends::*Controller's set_* (the public trend page, its limit and
  // offset); approve and reject answer the one record of params[:id].
  "app/controllers/api/v1/trends/tags_controller.rb set_tags": ["approve", "reject"],
  "app/controllers/api/v1/trends/links_controller.rb set_links": ["approve", "reject"],
  "app/controllers/api/v1/trends/statuses_controller.rb set_statuses": ["approve", "reject"],
};

/**
 * @param {RawRoute} route
 * @param {string} checkout
 * @param {Map<string, Controller | null>} cache
 * @param {Set<string>} siblingPathParams path parameters of the other routes to the same action
 * @returns {{ names: string[], unresolved: string[] } | null}
 */
function requestParams(route, checkout, cache, siblingPathParams) {
  if (route.controller === null || route.action === null) return null;
  const file = `app/controllers/${route.controller}_controller.rb`;
  const controller = readController(checkout, file, cache);
  if (controller === null) return null;
  const sources = methodSources(checkout, controller.chain);
  const action = route.action;
  /** @type {Callback[]} */
  const active = [];
  for (const cb of controller.callbacks) {
    if (cb.after || cb.unreadable !== null || !applies(cb, action)) continue;
    if (cb.skip) {
      active.splice(0, active.length, ...active.filter((other) => other.callback !== cb.callback));
      continue;
    }
    if (DISCARDED_CALLBACKS[`${cb.file} ${cb.callback}`]?.includes(action)) continue;
    active.push(cb);
  }
  /** @type {Reads['calls']} */
  const start = [action, ...active.flatMap((cb) => [cb.callback, ...cb.conditions])].map((name) => ({
    name,
    paths: null,
  }));
  const stack = new Set();
  /**
   * Everything a method reads, its calls followed (a cycle ends at the method already on the stack), and the path of
   * the record its value stands for.
   * @param {string} name
   * @returns {{ names: Set<string>, unresolved: Set<string>, root: string[] }}
   */
  const methodReads = (name) => {
    const none = { names: new Set(), unresolved: new Set(), root: [] };
    if (stack.has(name)) return none;
    const method = findMethod(sources, name);
    if (method === null) {
      return { ...none, unresolved: new Set(name.endsWith("_params") ? [`${file}: method ${name} not found`] : []) };
    }
    stack.add(name);
    const reads = bodyReads(method.body, `${method.file} ${name}`, method.file, sources, checkout);
    const result = { ...follow(reads), root: reads.root };
    stack.delete(name);
    return result;
  };
  /** @param {Reads} reads */
  const follow = (reads) => {
    const names = new Set(reads.names);
    const unresolved = new Set(reads.unresolved);
    for (const call of reads.calls) {
      const sub = methodReads(call.name);
      const paths = call.paths?.map((p) => [...sub.root, ...p]) ?? null;
      for (const n of sub.names) {
        const segs = segments(n);
        if (paths === null || paths.some((p) => p.every((key, i) => segs[i] === key))) names.add(n);
      }
      for (const reason of sub.unresolved) unresolved.add(reason);
    }
    return { names, unresolved };
  };
  const lambdas = active.filter((cb) => cb.args !== "").map((cb) => `${cb.callback} ${cb.args}`);
  const read = follow({ names: new Set(), unresolved: [], calls: start, root: [] });
  for (const text of lambdas) {
    const more = follow(bodyReads(text, `${file} callback`, file, sources, checkout));
    for (const n of more.names) read.names.add(n);
    for (const r of more.unresolved) read.unresolved.add(r);
  }
  const pathParams = new Set([...route.path.matchAll(/:(\w+)/g)].map((m) => m[1]));
  const all = [...read.names].filter((name) => {
    const head = /** @type {string} */ (segments(name)[0]);
    return !pathParams.has(head) && !siblingPathParams.has(head) && !RAILS_KEYS.has(head);
  });
  // A container read for presence (params[:source].blank?) next to its members is the members.
  const kept = all.filter(
    (name) => !all.some((other) => other.startsWith(`${name}[`) && !other.startsWith(`${name}[]`)),
  );
  return { names: kept.toSorted(), unresolved: [...read.unresolved].toSorted() };
}

// ---- Entity fields ----

// The fields the serializers of ENTITIES emit, which test-node/mastodon-entities.test.ts checks Kopje's response types
// carry: `attribute`/`attributes` and `has_one`/`has_many`/`belongs_to` (named by `key:` when given), `optional` when
// an `if:`/`unless:` decides whether the field is emitted. A class's own body only (an inner class such as
// AccountSerializer::FieldSerializer is an entity of its own), after its superclass's fields when that is a serializer
// of app/serializers. `<Class>#<method>` is the hash a method returns, read from its literal keys. What cannot be read
// with certainty is `unresolved`.
const ENTITIES = [
  "REST::AccountSerializer",
  "REST::AccountSerializer::FieldSerializer",
  "REST::CredentialAccountSerializer",
  "REST::CredentialAccountSerializer#source",
  "REST::StatusSerializer",
  "REST::MediaAttachmentSerializer",
  "REST::PollSerializer",
  "REST::PreviewCardSerializer",
  "REST::TagSerializer",
  "REST::NotificationSerializer",
  "REST::NotificationGroupSerializer",
  "REST::RelationshipSerializer",
  "REST::ApplicationSerializer",
  "REST::CredentialApplicationSerializer",
  "REST::FilterSerializer",
  "REST::AnnouncementSerializer",
  "REST::AnnouncementSerializer::AccountSerializer",
  "REST::ReactionSerializer",
];

const DECLARATIONS = /^(attributes|attribute|has_one|has_many|belongs_to)\b\s*(.*)$/s;

/**
 * @typedef {{ name: string, optional: boolean }} Field
 * @typedef {{ fields: Field[], unresolved: string[] }} Entity
 */

// The lines of a class body (`class <name>` up to its `end`), the bodies of classes nested in it blanked.
/** @param {string} text @param {string} name */
function classBody(text, name) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^\\s*class ${escapeRegExp(name)}\\b`).test(line));
  if (start < 0) return null;
  const indent = /^\s*/.exec(lines[start] ?? "")?.[0].length ?? 0;
  const end = lines.findIndex((line, i) => i > start && new RegExp(`^\\s{${indent}}end\\b`).test(line));
  const body = lines.slice(start + 1, end < 0 ? lines.length : end);
  /** @type {string[]} */
  const own = [];
  let nested = -1;
  for (const line of body) {
    const lead = /^\s*/.exec(line)?.[0].length ?? 0;
    if (nested >= 0) {
      if (lead === nested && /^\s*end\b/.test(line)) nested = -1;
      own.push("");
      continue;
    }
    if (/^\s*class\s/.test(line)) {
      nested = lead;
      own.push("");
      continue;
    }
    own.push(line);
  }
  return { lines: own, indent: indent + 2, superclass: /<\s*([\w:]+)/.exec(lines[start] ?? "")?.[1] ?? null };
}

/** @param {string} className */
const serializerFile = (className) => classFile(className).replace("app/controllers/", "app/serializers/");

/**
 * @param {string} checkout
 * @param {string} entity
 * @returns {Entity}
 */
export function entityFields(checkout, entity) {
  const [className = "", method] = entity.split("#");
  const parts = className.split("::");
  // An inner class lives in its outer class's file.
  const outer =
    parts.length > 2 && (parts.at(-2) ?? "").endsWith("Serializer") ? parts.slice(0, -1).join("::") : className;
  const file = serializerFile(outer);
  if (!existsSync(join(checkout, file))) {
    return { fields: [], unresolved: [`${file} not found`] };
  }
  const text = stripComments(readFileSync(join(checkout, file), "utf8"));
  if (method !== undefined) {
    return hashKeys(text, method, file);
  }
  const body = classBody(text, outer === className ? className : /** @type {string} */ (parts.at(-1)));
  if (body === null) {
    return { fields: [], unresolved: [`${file}: no class ${className}`] };
  }
  /** @type {Map<string, boolean>} */
  const fields = new Map();
  /** @type {string[]} */
  const unresolved = [];
  const inherited = body.superclass;
  if (inherited !== null && inherited !== "ActiveModel::Serializer") {
    if (existsSync(join(checkout, serializerFile(inherited)))) {
      const parent = entityFields(checkout, inherited);
      for (const field of parent.fields) fields.set(field.name, field.optional);
      unresolved.push(...parent.unresolved);
    } else {
      unresolved.push(`${file}: superclass ${inherited} not read`);
    }
  }
  for (const { indent, text: stmt } of statements(body.lines.join("\n"))) {
    const m = DECLARATIONS.exec(stmt);
    if (m === null || indent !== body.indent) continue;
    const { positional, options } = callArgs(/** @type {string} */ (m[2]).replace(/^\((.*)\)$/s, "$1"));
    const optional = options.if !== undefined || options.unless !== undefined;
    const names = m[1] === "attributes" ? positional : positional.slice(0, 1);
    if (names.length === 0 || names.some((n) => typeof n !== "string")) {
      unresolved.push(`${file}: \`${stmt}\``);
      continue;
    }
    for (const name of /** @type {string[]} */ (names)) {
      const key = m[1] === "attributes" ? name : typeof options.key === "string" ? options.key : name;
      fields.set(key, (fields.get(key) ?? true) && optional);
    }
  }
  return {
    fields: [...fields].map(([name, optional]) => ({ name, optional })).toSorted((a, b) => (a.name < b.name ? -1 : 1)),
    unresolved,
  };
}

// The keys of the hash literal a method returns (its last expression).
/** @param {string} text @param {string} method @param {string} file @returns {Entity} */
function hashKeys(text, method, file) {
  const body = actionBody(text, method);
  const literalHash = body === null ? null : /\{([\s\S]*)\}\s*end\b/.exec(body);
  if (literalHash === null) {
    return { fields: [], unresolved: [`${file} ${method}: no hash literal returned`] };
  }
  /** @type {Field[]} */
  const fields = [];
  for (const part of splitArgs(/** @type {string} */ (literalHash[1]).trim())) {
    const key = /^(\w+):\s/.exec(part)?.[1];
    if (key === undefined) {
      return { fields: [], unresolved: [`${file} ${method}: unreadable \`${part}\``] };
    }
    fields.push({ name: key, optional: false });
  }
  return { fields: fields.toSorted((a, b) => (a.name < b.name ? -1 : 1)), unresolved: [] };
}

// ---- Output ----

/** @param {string} checkout */
function version(checkout) {
  const text = readFileSync(join(checkout, "lib", "mastodon", "version.rb"), "utf8");
  const part = (/** @type {string} */ name) => new RegExp(`def ${name}\\s+(\\d+)\\s+end`).exec(text)?.[1];
  const [major, minor, patch] = [part("major"), part("minor"), part("patch")];
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error("lib/mastodon/version.rb: no version");
  }
  return `${major}.${minor}.${patch}`;
}

// Routes outside /api that clients call with a bearer token, served by an Api::BaseController.
const OUTSIDE_API = new Set(["/oauth/userinfo"]);

export function mastodonAccessTable(/** @type {string} */ checkout) {
  const cache = new Map();
  const raw = readRoutes(checkout);
  /** @param {RawRoute} route */
  const target = (route) => `${route.controller}#${route.action}`;
  /** @type {Map<string, Set<string>>} */
  const actionPathParams = new Map();
  for (const route of raw) {
    const set = actionPathParams.get(target(route)) ?? new Set();
    for (const m of route.path.matchAll(/:(\w+)/g)) set.add(/** @type {string} */ (m[1]));
    actionPathParams.set(target(route), set);
  }
  const routes = raw
    .filter((route) => route.path.startsWith("/api/") || OUTSIDE_API.has(route.path) || route.method === "?")
    .map((route) => {
      const params = requestParams(route, checkout, cache, actionPathParams.get(target(route)) ?? new Set());
      return { ...access(route, checkout, cache), ...(params === null ? {} : { params }) };
    });
  const v = version(checkout);
  return {
    mastodon: v,
    generatedBy: `(in packages/kopje) node scripts/mastodon-scopes.mjs <checkout of Mastodon v${v}>`,
    note: [
      "Generated from config/routes.rb, app/controllers/api/** and the API controllers outside /api (/oauth/userinfo) by reading the Ruby source; do not edit by hand.",
      "token: required (doorkeeper_authorize!, require_user!, valid_doorkeeper_token?), optional (authorize_if_got_token!, or the controller reads the current user), none.",
      "scopes: any one of them is accepted (null: no scope check). user: a token without a user is refused.",
      "Not read: instance settings (DISALLOW_UNAUTHENTICATED_API_ACCESS, limited federation mode), serializers that read the current user.",
      "unresolved: the Ruby could not be read with certainty; the route is not compared until an exception says why.",
      "params: the request parameters the action reads (names in Params form: a, a[], a[b], a[][b]); params.unresolved: reads it could not name.",
      "entities: the fields each serializer of ENTITIES emits (optional: an if:/unless: decides); entities.unresolved: what could not be read.",
      "On a Mastodon version bump: regenerate, review the new exceptions the tests report, and run a Claude + Codex audit for read-but-dropped parameters.",
    ],
    routes,
    entities: Object.fromEntries(ENTITIES.map((entity) => [entity, entityFields(checkout, entity)])),
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [checkout, out] = process.argv.slice(2);
  if (checkout === undefined) {
    console.error("usage: node scripts/mastodon-scopes.mjs <mastodon checkout> [<out file>]");
    process.exit(2);
  }
  const table = mastodonAccessTable(resolve(checkout));
  const target = out ?? join(root, "test", "fixtures", `mastodon-${table.mastodon}-api-access.json`);
  // The repository's formatter settings, so the fixture passes the format check as written. format() reads no
  // config file itself; the file-matching keys are not format options.
  const { $schema, ignorePatterns, ...config } = JSON.parse(
    readFileSync(join(root, "..", "..", ".oxfmtrc.json"), "utf8"),
  );
  const { format } = await import("oxfmt");
  // Named as JSON whatever the output file is called: format() picks its parser by the name.
  const formatted = await format("access.json", JSON.stringify(table), config);
  if (formatted.errors.length > 0) {
    throw new Error(`oxfmt: ${formatted.errors.map((e) => e.message).join("; ")}`);
  }
  writeFileSync(target, formatted.code);
  const unresolved = table.routes.filter((r) => "unresolved" in r).length;
  console.log(`${target}: ${table.routes.length} routes, ${unresolved} unresolved`);
}
