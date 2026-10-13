// The package's public entry: the Worker's handlers and the Store Durable Object class. An instance re-exports both
// from its own entry module (`export { default, Store } from 'kopje'`); nothing else in the package is public API.
// The parameters are left opaque on purpose: the runtime passes them, and an instance never calls these itself.

export interface KopjeWorker {
	fetch(request: Request, env: unknown, ctx: unknown): Response | Promise<Response>
	queue(batch: unknown, env: unknown): Promise<void>
	scheduled(controller: unknown, env: unknown, ctx: unknown): void
}

declare const worker: KopjeWorker
export default worker

// The SQLite-backed Durable Object that holds the instance. Bind it as STORE with a `new_sqlite_classes` migration.
export declare class Store {
	constructor(ctx: unknown, env: unknown)
}
