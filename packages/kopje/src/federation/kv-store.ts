import type { KvKey, KvStore, KvStoreListEntry, KvStoreSetOptions } from "@fedify/fedify";
import { Temporal } from "temporal-polyfill";

import { callStore, type StoreStub } from "../platform/store-client";

// Fedify's KvStore backed by the Store's fedify_kv table (domain/fedify-kv.ts): get and list are read operations,
// set, delete and cas are write operations, one RPC each. Keys and values cross the RPC as JSON text. TTLs become an
// absolute expires_at from the injected clock.
export class DoKvStore implements KvStore {
  constructor(
    private readonly store: () => StoreStub,
    private readonly build: string,
    private readonly now: () => number,
  ) {}

  async get<T = unknown>(key: KvKey): Promise<T | undefined> {
    const value = await callStore(() => this.store().kvGet(this.build, { key: encodeKey(key), now: this.now() }));
    return value === null ? undefined : (JSON.parse(value) as T);
  }

  async set(key: KvKey, value: unknown, options?: KvStoreSetOptions): Promise<void> {
    await callStore(() =>
      this.store().kvSet(this.build, {
        key: encodeKey(key),
        value: JSON.stringify(value),
        expiresAt: this.#expiry(options),
      }),
    );
  }

  async delete(key: KvKey): Promise<void> {
    await callStore(() => this.store().kvDelete(this.build, { key: encodeKey(key) }));
  }

  cas(key: KvKey, expectedValue: unknown, newValue: unknown, options?: KvStoreSetOptions): Promise<boolean> {
    return callStore(() =>
      this.store().kvCas(this.build, {
        key: encodeKey(key),
        expected: expectedValue === undefined ? null : JSON.stringify(expectedValue),
        value: newValue === undefined ? null : JSON.stringify(newValue),
        expiresAt: this.#expiry(options),
        now: this.now(),
      }),
    );
  }

  async *list(prefix?: KvKey): AsyncIterable<KvStoreListEntry> {
    const entries = await callStore(() =>
      this.store().kvList(this.build, {
        prefix: prefix === undefined || prefix.length === 0 ? null : encodeKey(prefix),
        now: this.now(),
      }),
    );
    for (const entry of entries) {
      yield { key: JSON.parse(entry.key) as KvKey, value: JSON.parse(entry.value) as unknown };
    }
  }

  #expiry(options?: KvStoreSetOptions): number | null {
    // Fedify's types name the global Temporal, which this TypeScript lib lacks; the value is a polyfill Duration.
    const ttl = options?.ttl as Temporal.Duration | undefined;
    return ttl === undefined ? null : this.now() + Temporal.Duration.from(ttl).total("millisecond");
  }
}

function encodeKey(key: KvKey): string {
  return JSON.stringify(key);
}
