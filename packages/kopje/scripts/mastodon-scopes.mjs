// Writes the access table of Mastodon's /api/** routes, which test/mastodon-access.test.ts checks Kopje's route table
// (src/mastodon/routes.ts) against. For each route: the method, the path (`:param` form), the controller action, and
// what the action requires of the caller:
//   token   'required'  doorkeeper_authorize!, require_user!, or valid_doorkeeper_token? in the action
//           'optional'  authorize_if_got_token!, or no doorkeeper check but the controller reads the current user
//           'none'      neither: no token is read
//   scopes  the scopes doorkeeper accepts (any one of them), null when no scope is checked
//   user    require_user! or require_authenticated_user! (a token without a user is refused)
//   guards  other require_* callbacks the action runs (informative, not compared)
// Where the Ruby cannot be read with certainty (a conditional callback, an unknown routing statement, a controller
// not found), the route carries `unresolved` with the reasons instead of a guess.
//
// It only reads the checkout: config/routes.rb (and the files it draws), app/controllers/api/**.
//
//   node scripts/mastodon-scopes.mjs <mastodon checkout> [<out file>]
//   (default: test/fixtures/mastodon-<version>-api-access.json)
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

// ---- Ruby source helpers ----

// Lines without comments, a statement split over lines (open brackets, a trailing comma) joined into one.
/** @param {string} text */
function statements(text) {
	/** @type {{ indent: number, text: string }[]} */
	const out = []
	let pending = ''
	let indent = 0
	for (const raw of text.split('\n')) {
		const line = raw.replace(/\s+#(?![{]).*$/, '').replace(/^\s*#.*$/, '')
		if (pending === '') {
			if (line.trim() === '') {
				continue
			}
			indent = line.length - line.trimStart().length
		}
		pending = pending === '' ? line.trim() : `${pending} ${line.trim()}`
		if (depth(pending) > 0 || pending.endsWith(',')) {
			continue
		}
		out.push({ indent, text: pending })
		pending = ''
	}
	if (pending !== '') {
		out.push({ indent, text: pending })
	}
	return out
}

/** @param {string} s */
function depth(s) {
	let d = 0
	let quote = ''
	for (const ch of s) {
		if (quote !== '') {
			if (ch === quote) quote = ''
		} else if (ch === "'" || ch === '"') {
			quote = ch
		} else if ('([{'.includes(ch)) {
			d++
		} else if (')]}'.includes(ch)) {
			d--
		}
	}
	return d
}

// Splits an argument list at its top-level commas.
/** @param {string} s */
function splitArgs(s) {
	/** @type {string[]} */
	const parts = []
	let d = 0
	let quote = ''
	let cur = ''
	for (const ch of s) {
		if (quote !== '') {
			if (ch === quote) quote = ''
		} else if (ch === "'" || ch === '"') {
			quote = ch
		} else if ('([{'.includes(ch)) {
			d++
		} else if (')]}'.includes(ch)) {
			d--
		} else if (ch === ',' && d === 0) {
			parts.push(cur.trim())
			cur = ''
			continue
		}
		cur += ch
	}
	if (cur.trim() !== '') {
		parts.push(cur.trim())
	}
	return parts
}

// A Ruby literal: a symbol or string as a string, an array of them as an array, anything else as { opaque }.
/** @param {string} v @returns {string | string[] | { opaque: string }} */
function literal(v) {
	const value = v.trim()
	let m = /^:'([^']*)'$|^:"([^"]*)"$|^:([\w?!]+)$|^'([^']*)'$|^"([^"]*)"$/.exec(value)
	if (m) {
		return m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? ''
	}
	m = /^\[(.*)\]$/.exec(value)
	if (m) {
		const items = splitArgs(m[1] ?? '').map(literal)
		if (items.every((i) => typeof i === 'string')) {
			return /** @type {string[]} */ (items)
		}
	}
	m = /^%[iw][([](.*)[)\]]$/.exec(value)
	if (m) {
		return (m[1] ?? '').trim().split(/\s+/)
	}
	return { opaque: value }
}

// Positional arguments and options of a call's argument list.
/** @param {string} s */
function callArgs(s) {
	/** @type {(string | string[] | { opaque: string })[]} */
	const positional = []
	/** @type {Record<string, string | string[] | { opaque: string }>} */
	const options = {}
	for (const part of splitArgs(s)) {
		const m = /^(\w+):\s+(.*)$/s.exec(part) ?? /^:(\w+)\s*=>\s*(.*)$/s.exec(part)
		if (m && m[1] !== undefined && m[2] !== undefined) {
			options[m[1]] = literal(m[2])
		} else {
			positional.push(literal(part))
		}
	}
	return { positional, options }
}

/** @param {unknown} v @returns {string[] | null} */
function list(v) {
	if (typeof v === 'string') return [v]
	if (Array.isArray(v)) return v
	return null
}

/** @param {string} word */
function singular(word) {
	if (word.endsWith('ies')) return `${word.slice(0, -3)}y`
	if (/(ss|us|x|ch|sh)es$/.test(word)) return word.slice(0, -2)
	if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
	return word
}

/** @param {string} word */
function plural(word) {
	if (word.endsWith('s')) return word
	if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`
	if (/(x|ch|sh)$/.test(word)) return `${word}es`
	return `${word}s`
}

// ---- Routes ----

const RESOURCES_ACTIONS = /** @type {const} */ ([
	['index', ['GET'], 'collection'],
	['create', ['POST'], 'collection'],
	['new', ['GET'], 'new'],
	['edit', ['GET'], 'edit'],
	['show', ['GET'], 'member'],
	['update', ['PATCH', 'PUT'], 'member'],
	['destroy', ['DELETE'], 'member'],
])
const RESOURCE_ACTIONS = /** @type {const} */ ([
	['create', ['POST'], 'self'],
	['new', ['GET'], 'new'],
	['edit', ['GET'], 'edit'],
	['show', ['GET'], 'self'],
	['update', ['PATCH', 'PUT'], 'self'],
	['destroy', ['DELETE'], 'self'],
])
const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'match'])

/**
 * @typedef {{ method: string, path: string, controller: string | null, action: string | null, unresolved: string[] }} RawRoute
 * @typedef {{
 *   kind: 'scope' | 'resources' | 'member' | 'collection' | 'opaque',
 *   path: string,
 *   module: string,
 *   defaults?: Record<string, unknown>,
 *   controller?: string,
 *   memberPath?: string,
 *   collectionPath?: string,
 *   param?: string,
 *   unknown?: string,
 *   pendingDefaults?: RawRoute[],
 * }} Frame
 */

// Interprets the routing DSL of config/routes.rb and the files it draws. Statements outside an /api path are
// interpreted as far as needed to keep the block structure; an unknown one under /api makes its routes unresolved.
/** @param {string} checkout */
function readRoutes(checkout) {
	/** @type {RawRoute[]} */
	const routes = []
	const main = readFileSync(join(checkout, 'config', 'routes.rb'), 'utf8')
	const start = main.indexOf('Rails.application.routes.draw do')
	if (start < 0) {
		throw new Error('config/routes.rb: no `Rails.application.routes.draw do`')
	}
	/** @type {Frame[]} */
	const stack = [{ kind: 'scope', path: '', module: '' }]
	interpret(main.slice(start).split('\n').slice(1).join('\n'), stack, routes, checkout, 'config/routes.rb')
	return routes
}

/**
 * @param {string} text
 * @param {Frame[]} stack
 * @param {RawRoute[]} routes
 * @param {string} checkout
 * @param {string} file
 */
function interpret(text, stack, routes, checkout, file) {
	const base = stack.length
	for (const { text: stmt } of statements(text)) {
		const top = /** @type {Frame} */ (stack.at(-1))
		const opensBlock = /\bdo(\s*\|[^|]*\|)?$/.test(stmt)
		const head = opensBlock ? stmt.replace(/\s*\bdo(\s*\|[^|]*\|)?$/, '') : stmt
		if (stmt === 'end') {
			if (stack.length <= base) {
				// The `end` of Rails.application.routes.draw.
				return
			}
			// A resource's own routes follow the ones of its block, as Rails draws them.
			routes.push(...(stack.pop()?.pendingDefaults ?? []))
			continue
		}
		if (/^(if|unless|case|begin|def|class|module|while)\b/.test(stmt) && !/\bend$/.test(stmt)) {
			stack.push({ kind: 'opaque', path: top.path, module: top.module, unknown: stmt })
			continue
		}
		const m = /^(\w+)\((.*)\)$/s.exec(head) ?? /^(\w+)(?:\s+(.*))?$/s.exec(head)
		const name = m?.[1] ?? ''
		const args = callArgs(m?.[2] ?? '')
		const draw = name === 'draw' ? args.positional[0] : undefined
		if (typeof draw === 'string') {
			const drawn = join(checkout, 'config', 'routes', `${draw}.rb`)
			interpret(readFileSync(drawn, 'utf8'), stack, routes, checkout, `config/routes/${draw}.rb`)
			continue
		}
		const frame = enter(name, args, top, stmt)
		if (frame === 'verb') {
			for (const route of verbRoutes(name, args, stack)) {
				routes.push(route)
			}
			continue
		}
		if (frame !== null && 'defaultRoutes' in frame) {
			if (opensBlock) {
				stack.push({ ...frame.frame, pendingDefaults: frame.defaultRoutes })
			} else {
				routes.push(...frame.defaultRoutes)
			}
			continue
		}
		if (opensBlock) {
			stack.push(frame ?? { kind: 'opaque', path: top.path, module: top.module, unknown: stmt })
			continue
		}
		if (top.path.startsWith('/api') || stmt.includes('/api')) {
			routes.push({ method: '?', path: top.path, controller: null, action: null, unresolved: [`${file}: ${stmt}`] })
		}
	}
}

/** @param {Frame[]} stack */
function inherited(stack) {
	/** @type {Record<string, unknown>} */
	const defaults = {}
	const unresolved = []
	for (const frame of stack) {
		Object.assign(defaults, frame.defaults ?? {})
		if (frame.kind === 'opaque' && frame.path.startsWith('/api')) {
			unresolved.push(`inside \`${frame.unknown}\``)
		}
	}
	return { defaults, unresolved }
}

/**
 * The frame a scoping statement opens, the default routes of a resource, 'verb' for a route, or null.
 * @param {string} name
 * @param {ReturnType<typeof callArgs>} args
 * @param {Frame} top
 * @param {string} stmt
 * @returns {Frame | 'verb' | null | { frame: Frame, defaultRoutes: RawRoute[] }}
 */
function enter(name, args, top, stmt) {
	const first = args.positional[0]
	const { options } = args
	const nested = nestedPath(top)
	if (name === 'namespace' && typeof first === 'string') {
		const path = typeof options.path === 'string' ? options.path : first
		return { kind: 'scope', path: `${nested}/${path}`, module: `${top.module}${first}/` }
	}
	if (name === 'scope') {
		const path = typeof options.path === 'string' ? options.path : typeof first === 'string' ? first : ''
		const mod = typeof options.module === 'string' ? `${options.module}/` : ''
		const known = Object.keys(options).every((k) => ['path', 'module', 'as'].includes(k))
		return {
			kind: known ? 'scope' : 'opaque',
			path: path === '' ? nested : `${nested}/${path.replace(/^\//, '')}`,
			module: `${top.module}${mod}`,
			unknown: known ? undefined : stmt,
		}
	}
	if (name === 'with_options') {
		return { kind: 'scope', path: nested, module: top.module, defaults: options }
	}
	if (name === 'member' || name === 'collection') {
		if (top.kind !== 'resources') {
			return { kind: 'opaque', path: top.path, module: top.module, unknown: stmt }
		}
		return {
			kind: name,
			path: name === 'member' ? /** @type {string} */ (top.memberPath) : /** @type {string} */ (top.collectionPath),
			module: top.module,
			controller: top.controller,
		}
	}
	if ((name === 'resources' || name === 'resource') && typeof first === 'string') {
		return resourceFrame(name === 'resources', first, options, top, stmt)
	}
	if (VERBS.has(name)) {
		return 'verb'
	}
	return null
}

// The path a statement nested directly in a frame starts from: under a plural resource, its :<singular>_id.
/** @param {Frame} top */
function nestedPath(top) {
	if (top.kind === 'resources') {
		return `${top.collectionPath}/:${singular(top.path.split('/').at(-1) ?? '')}_${top.param ?? 'id'}`
	}
	return top.path
}

/**
 * @param {boolean} isPlural
 * @param {string} name
 * @param {Record<string, unknown>} options
 * @param {Frame} top
 * @param {string} stmt
 */
function resourceFrame(isPlural, name, options, top, stmt) {
	const unresolved = []
	const known = ['only', 'except', 'controller', 'path', 'param', 'module', 'as', 'concerns', 'constraints']
	for (const key of Object.keys(options)) {
		if (!known.includes(key) || (key === 'concerns' && top.path.startsWith('/api'))) {
			unresolved.push(`option ${key}: in \`${stmt}\``)
		}
	}
	const module = typeof options.module === 'string' ? `${top.module}${options.module}/` : top.module
	const segment = typeof options.path === 'string' ? options.path : name
	const path = `${nestedPath(top)}/${segment}`
	const controllerName = typeof options.controller === 'string' ? options.controller : isPlural ? name : plural(name)
	const controller = `${module}${controllerName}`
	const param = typeof options.param === 'string' ? options.param : 'id'
	const table = isPlural ? RESOURCES_ACTIONS : RESOURCE_ACTIONS
	const only = list(options.only)
	const except = list(options.except) ?? []
	/** @type {RawRoute[]} */
	const defaultRoutes = []
	for (const [action, methods, where] of table) {
		if ((only !== null && !only.includes(action)) || except.includes(action)) {
			continue
		}
		const actionPath =
			where === 'collection' || where === 'self'
				? path
				: where === 'member'
					? `${path}/:${param}`
					: where === 'new'
						? `${path}/new`
						: `${path}/:${param}/edit`
		for (const method of methods) {
			defaultRoutes.push({ method, path: actionPath, controller, action, unresolved: [...unresolved] })
		}
	}
	/** @type {Frame} */
	const frame = {
		// A singular resource nests its children under its own path, as a scope.
		kind: isPlural ? 'resources' : 'scope',
		path,
		module,
		controller,
		collectionPath: path,
		memberPath: `${path}/:${param}`,
		param,
	}
	return { frame, defaultRoutes }
}

/**
 * @param {string} verb
 * @param {ReturnType<typeof callArgs>} args
 * @param {Frame[]} stack
 * @returns {RawRoute[]}
 */
function verbRoutes(verb, args, stack) {
	const top = /** @type {Frame} */ (stack.at(-1))
	const { defaults, unresolved } = inherited(stack)
	const options = { ...defaults, ...args.options }
	const first = args.positional[0]
	const base = top.kind === 'member' || top.kind === 'collection' ? top.path : nestedPath(top)
	const segment = typeof first === 'string' ? first : ''
	if (typeof first !== 'string') {
		unresolved.push(`path ${JSON.stringify(first)}`)
	}
	const joined = segment.startsWith('/') ? `${base}${segment}` : `${base}/${segment}`
	let controller = null
	let action = null
	const to = options.to
	if (typeof to === 'string' && /^[\w/]+#[\w?!]+$/.test(to)) {
		const [c, a] = to.split('#')
		controller = `${top.module}${c}`
		action = a ?? null
	} else if (to === undefined && (top.kind === 'member' || top.kind === 'collection' || top.kind === 'resources')) {
		controller = top.controller ?? null
		action = segment
	} else {
		unresolved.push(`target ${JSON.stringify(to ?? null)}`)
	}
	if (typeof options.controller === 'string' && controller === null) {
		controller = `${top.module}${options.controller}`
	}
	let methods = [verb.toUpperCase()]
	if (verb === 'match') {
		const via = list(options.via)
		methods = via === null ? ['?'] : via.map((v) => v.toUpperCase())
		if (via === null) unresolved.push('match without via:')
	}
	// An optional segment `(...)` is written as present.
	const path = joined
		.replace(/\(([^)]*)\)/g, '$1')
		.replace(/\/+/g, '/')
		.replace(/\/$/, '')
	return methods.map((method) => ({ method, path, controller, action, unresolved: [...unresolved] }))
}

// ---- Controllers ----

/**
 * @typedef {{ file: string, callback: string, args: string, only: string[] | null, except: string[] | null, conditional: string | null, nested: boolean, skip: boolean }} Callback
 * @typedef {{ callbacks: Callback[], unresolved: string[], chain: string[] }} Controller
 */

const TRACKED = new Set([
	'doorkeeper_authorize!',
	'authorize_if_got_token!',
	'require_user!',
	'require_authenticated_user!',
])
const API_BASE = 'Api::BaseController'

/** @param {string} className */
function classFile(className) {
	return `app/controllers/${className
		.split('::')
		.map((part) => part.replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase())
		.join('/')}.rb`
}

/**
 * @param {string} checkout
 * @param {string} file relative to the checkout
 * @param {Map<string, Controller | null>} cache
 * @returns {Controller | null}
 */
function readController(checkout, file, cache) {
	if (cache.has(file)) {
		return cache.get(file) ?? null
	}
	cache.set(file, null)
	const path = join(checkout, file)
	if (!existsSync(path)) {
		return null
	}
	const text = readFileSync(path, 'utf8')
	const unresolved = []
	const klass = /^class\s+([\w:]+)\s*<\s*([\w:]+)/m.exec(text)
	/** @type {Controller} */
	let parent = { callbacks: [], unresolved: [], chain: [] }
	if (klass === null) {
		unresolved.push(`${file}: no class declaration`)
	} else if (klass[1] !== API_BASE && klass[2] !== 'ApplicationController') {
		const parentFile = classFile(/** @type {string} */ (klass[2]))
		const read = readController(checkout, parentFile, cache)
		if (read === null) {
			unresolved.push(`${file}: parent ${klass[2]} not found`)
		} else {
			parent = read
		}
	}
	for (const mod of text.matchAll(/^\s*include\s+([\w:]+)/gm)) {
		const concern = join(
			checkout,
			classFile(/** @type {string} */ (mod[1])).replace('app/controllers/', 'app/controllers/concerns/')
		)
		if (
			existsSync(concern) &&
			/doorkeeper_authorize!|authorize_if_got_token!|require_user!/.test(readFileSync(concern, 'utf8'))
		) {
			unresolved.push(`${file}: concern ${mod[1]} checks access`)
		}
	}
	/** @type {Callback[]} */
	const callbacks = []
	let classIndent = null
	for (const { indent, text: stmt } of statements(text)) {
		if (/^class\b/.test(stmt) && classIndent === null) {
			classIndent = indent + 2
			continue
		}
		const m = /^(prepend_before_action|before_action|skip_before_action)\s+(.*)$/s.exec(stmt)
		if (m === null) {
			continue
		}
		const skip = m[1] === 'skip_before_action'
		const parts = splitArgs(/** @type {string} */ (m[2]))
		const target = parts[0] ?? ''
		let callback = ''
		let cbArgs = ''
		const lambda = /^->\s*\{\s*([\w!?]+)\s*(.*?)\s*\}$/s.exec(target)
		if (lambda) {
			callback = /** @type {string} */ (lambda[1])
			cbArgs = /** @type {string} */ (lambda[2])
		} else if (/^:[\w!?]+$/.test(target)) {
			callback = target.slice(1)
		} else {
			if (/doorkeeper|authorize|require_user/.test(target)) {
				unresolved.push(`${file}: callback \`${stmt}\``)
			}
			continue
		}
		if (!TRACKED.has(callback) && !callback.startsWith('require_')) {
			continue
		}
		const { options } = callArgs(parts.slice(1).join(', '))
		const conditionKeys = Object.keys(options).filter((k) => k === 'if' || k === 'unless')
		const conditional =
			conditionKeys.length > 0 ? conditionKeys.map((k) => `${k}: ${JSON.stringify(options[k])}`).join(', ') : null
		callbacks.push({
			callback,
			args: cbArgs,
			only: options.only === undefined ? null : list(options.only),
			except: options.except === undefined ? null : list(options.except),
			conditional,
			nested: classIndent !== null && indent > classIndent,
			file,
			skip,
		})
	}
	const controller = {
		callbacks: [...parent.callbacks, ...callbacks],
		unresolved: [...parent.unresolved, ...unresolved],
		chain: [...parent.chain, file],
	}
	cache.set(file, controller)
	return controller
}

/** @param {Callback} cb @param {string} action */
function applies(cb, action) {
	if (cb.only !== null && !cb.only.includes(action)) return false
	if (cb.except !== null && cb.except.includes(action)) return false
	return true
}

// The body of `def <action>` up to the next definition or visibility keyword.
/** @param {string} text @param {string} action */
function actionBody(text, action) {
	const start = text.search(new RegExp(`^[ \\t]*def ${action.replace(/[?!]/g, '\\$&')}(?![\\w?!])`, 'm'))
	if (start < 0) return null
	const rest = text.slice(start)
	const firstLine = rest.indexOf('\n') + 1
	const next = rest.slice(firstLine).search(/^[ \t]*(def |private\b|protected\b)/m)
	return next < 0 ? rest : rest.slice(0, firstLine + next)
}

/**
 * @param {RawRoute} route
 * @param {string} checkout
 * @param {Map<string, Controller | null>} cache
 */
function access(route, checkout, cache) {
	const unresolved = [...route.unresolved]
	const entry = {
		method: route.method,
		path: route.path,
		controller: route.controller,
		action: route.action,
	}
	if (route.controller === null || route.action === null) {
		return { ...entry, token: null, scopes: null, user: null, unresolved }
	}
	const file = `app/controllers/${route.controller}_controller.rb`
	const controller = readController(checkout, file, cache)
	if (controller === null) {
		unresolved.push(`${file} not found`)
		return { ...entry, token: null, scopes: null, user: null, unresolved }
	}
	unresolved.push(...controller.unresolved)
	const action = route.action
	/** @type {Callback[]} */
	const active = []
	for (const cb of controller.callbacks) {
		if (!applies(cb, action)) continue
		if (cb.skip) {
			for (let i = active.length - 1; i >= 0; i--) {
				if (active[i]?.callback !== cb.callback) continue
				if (cb.conditional !== null) unresolved.push(`skip_before_action ${cb.callback} ${cb.conditional}`)
				active.splice(i, 1)
			}
			continue
		}
		// Api::BaseController's gate for instances that close the API to anonymous callers (instance configuration).
		if (
			cb.callback === 'require_authenticated_user!' &&
			cb.conditional?.includes('disallow_unauthenticated_api_access?')
		) {
			continue
		}
		active.push(cb)
	}
	for (const cb of active) {
		if (TRACKED.has(cb.callback) && (cb.conditional !== null || cb.nested)) {
			unresolved.push(`${cb.callback} ${cb.conditional ?? 'inside a block'}`)
		}
	}
	const checks = active.filter(
		(cb) => cb.callback === 'doorkeeper_authorize!' || cb.callback === 'authorize_if_got_token!'
	)
	if (checks.length > 1) {
		unresolved.push(`${checks.length} scope checks`)
	}
	const check = checks[0]
	let scopes = null
	if (check !== undefined) {
		const parsed = callArgs(check.args).positional
		if (parsed.length === 0 || parsed.some((s) => typeof s !== 'string')) {
			unresolved.push(`scopes of ${check.callback} ${check.args}`)
		} else {
			scopes = /** @type {string[]} */ (parsed).toSorted()
		}
	}
	const user = active.some((cb) => cb.callback === 'require_user!' || cb.callback === 'require_authenticated_user!')
	const texts = controller.chain
		.filter((f) => f !== classFile(API_BASE))
		.map((f) => readFileSync(join(checkout, f), 'utf8'))
	const body = texts.map((t) => actionBody(t, action)).findLast((b) => b !== null) ?? null
	if (body === null && !/^(index|show|create|update|destroy)$/.test(action)) {
		unresolved.push(`no def ${action} in ${file}`)
	}
	const validToken = body !== null && /valid_doorkeeper_token\?/.test(body)
	// Api::BaseController reads the current user in every request; whether an action uses it is in its own chain. A
	// controller that overrides current_user to read it only in limited federation mode reads no user.
	const overrides = texts.map((t) => actionBody(t, 'current_user')).filter((b) => b !== null)
	if (overrides.some((b) => !/^\s*def current_user\s+super if limited_federation_mode\?\s+end\s*$/.test(b))) {
		unresolved.push('current_user overridden')
	}
	const readsUser = overrides.length === 0 && texts.some((t) => /\bcurrent_(user|account)\b|\buser_signed_in\?/.test(t))
	let token
	if (check?.callback === 'doorkeeper_authorize!') {
		token = 'required'
	} else if (check?.callback === 'authorize_if_got_token!') {
		token = user ? 'required' : 'optional'
	} else if (user || validToken) {
		token = 'required'
	} else {
		token = readsUser ? 'optional' : 'none'
	}
	const guards = active
		.filter((cb) => !TRACKED.has(cb.callback) && cb.file !== classFile(API_BASE))
		.map((cb) => cb.callback)
		.filter((name, i, all) => all.indexOf(name) === i)
	return {
		...entry,
		token,
		scopes,
		user,
		...(guards.length > 0 ? { guards } : {}),
		...(unresolved.length > 0 ? { unresolved } : {}),
	}
}

// ---- Output ----

// JSON as Prettier formats it: tab indented, an array of plain values on one line when it fits in 120 columns.
/** @param {unknown} value */
function format(value) {
	const item = String.raw`(?:"(?:[^"\\\n]|\\.)*"|null|true|false|-?\d+)`
	const plain = new RegExp(String.raw`\[\n\s*((?:${item},\n\s*)*${item})\n\s*\]`, 'g')
	const text = JSON.stringify(value, null, '\t')
	return `${text.replace(plain, (match, /** @type {string} */ items, /** @type {number} */ offset) => {
		const prefix = text.slice(text.lastIndexOf('\n', offset) + 1, offset)
		const inline = `[${items.split(/,\n\s*/).join(', ')}]`
		return `${prefix.replace(/\t/g, '  ')}${inline},`.length <= 120 ? inline : match
	})}\n`
}

/** @param {string} checkout */
function version(checkout) {
	const text = readFileSync(join(checkout, 'lib', 'mastodon', 'version.rb'), 'utf8')
	const part = (/** @type {string} */ name) => new RegExp(`def ${name}\\s+(\\d+)\\s+end`).exec(text)?.[1]
	const [major, minor, patch] = [part('major'), part('minor'), part('patch')]
	if (major === undefined || minor === undefined || patch === undefined) {
		throw new Error('lib/mastodon/version.rb: no version')
	}
	return `${major}.${minor}.${patch}`
}

export function mastodonAccessTable(/** @type {string} */ checkout) {
	const cache = new Map()
	const routes = readRoutes(checkout)
		.filter((route) => route.path.startsWith('/api/') || route.method === '?')
		.map((route) => access(route, checkout, cache))
	const v = version(checkout)
	return {
		mastodon: v,
		generatedBy: `(in packages/kopje) node scripts/mastodon-scopes.mjs <checkout of Mastodon v${v}>`,
		note: [
			'Generated from config/routes.rb and app/controllers/api/** by reading the Ruby source; do not edit by hand.',
			'token: required (doorkeeper_authorize!, require_user!, valid_doorkeeper_token?), optional (authorize_if_got_token!, or the controller reads the current user), none.',
			'scopes: any one of them is accepted (null: no scope check). user: a token without a user is refused.',
			'Not read: instance settings (DISALLOW_UNAUTHENTICATED_API_ACCESS, limited federation mode), serializers that read the current user.',
			'unresolved: the Ruby could not be read with certainty; the route is not compared until an exception says why.',
		],
		routes,
	}
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [checkout, out] = process.argv.slice(2)
	if (checkout === undefined) {
		console.error('usage: node scripts/mastodon-scopes.mjs <mastodon checkout> [<out file>]')
		process.exit(2)
	}
	const table = mastodonAccessTable(resolve(checkout))
	const target = out ?? join(root, 'test', 'fixtures', `mastodon-${table.mastodon}-api-access.json`)
	writeFileSync(target, format(table))
	const unresolved = table.routes.filter((r) => 'unresolved' in r).length
	console.log(`${target}: ${table.routes.length} routes, ${unresolved} unresolved`)
}
