import { vi } from "vitest";

// max_retries of the kopje consumer in wrangler.jsonc.
export const MAX_RETRIES = 100;
// Queues reject a message over 128 KB. Counted in decimal kilobytes to stay on the safe side.
export const MESSAGE_LIMIT = 128_000;

type Stored = { id: string; body: unknown; timestamp: Date; attempts: number; retries: number; delaySeconds: number };

// An upper bound of the V8 serialization size (workerd does not implement node:v8 serialize). Strings outside
// Latin-1 count two bytes per code unit, binary counts its bytes, and every value adds a small header.
export function v8SizeEstimate(value: unknown): number {
  const header = 8;
  if (typeof value === "string") {
    const latin1 = Array.from(value).every((char) => char.charCodeAt(0) <= 0xff);
    return header + (latin1 ? value.length : value.length * 2);
  }
  if (ArrayBuffer.isView(value)) {
    return header + value.byteLength;
  }
  if (value instanceof ArrayBuffer) {
    return header + value.byteLength;
  }
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + v8SizeEstimate(item), header);
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).reduce((sum, [key, item]) => sum + v8SizeEstimate(key) + v8SizeEstimate(item), header);
  }
  return header;
}

// An in-memory Queue with the platform's limits: messages must be structured-cloneable and fit MESSAGE_LIMIT, a
// retry counts against MAX_RETRIES and a message past it is dropped, and a batch whose handler returns acks every
// message it did not retry.
export class QueueSim {
  pending: Stored[] = [];
  dropped: Stored[] = [];
  retries = 0;
  #next = 0;

  readonly send = vi.fn((body: unknown, options?: QueueSendOptions): Promise<void> => {
    const cloned = structuredClone(body);
    const size = v8SizeEstimate(cloned);
    if (size > MESSAGE_LIMIT) {
      return Promise.reject(new Error(`Queue send failed: message too large (${size} bytes)`));
    }
    this.pending.push({
      id: String(++this.#next),
      body: cloned,
      timestamp: new Date(0),
      attempts: 1,
      retries: 0,
      delaySeconds: options?.delaySeconds ?? 0,
    });
    return Promise.resolve();
  });

  // The backlog as Queues reports it: every message not yet acknowledged counts in the bytes, but a delayed one is
  // left out of the count.
  metrics(): Promise<QueueMetrics> {
    const backlogBytes = this.pending.reduce((sum, m) => sum + v8SizeEstimate(m.body), 0);
    const backlogCount = this.pending.filter((m) => m.delaySeconds === 0).length;
    return Promise.resolve({ backlogCount, backlogBytes });
  }

  get queue(): Queue {
    return { send: this.send, metrics: () => this.metrics() } as unknown as Queue;
  }

  // Delivers everything pending as one batch, ignoring delays; with `ready`, only the messages sent without a delay
  // (the delayed ones stay pending, as they would until their delay passes).
  async deliver(handler: (batch: MessageBatch) => Promise<void> | void, { ready = false } = {}): Promise<void> {
    const stored = ready ? this.pending.filter((m) => m.delaySeconds === 0) : this.pending.splice(0);
    if (ready) {
      this.pending = this.pending.filter((m) => m.delaySeconds !== 0);
    }
    // A retry keeps the delay it was given (the consumer has no default retry delay, so none means immediate).
    const outcome = new Map<string, "ack" | { delaySeconds: number }>();
    const settle = (id: string, value: "ack" | { delaySeconds: number }) => {
      if (!outcome.has(id)) {
        outcome.set(id, value);
      }
    };
    const retry = (id: string, options?: QueueRetryOptions) => settle(id, { delaySeconds: options?.delaySeconds ?? 0 });
    const messages = stored.map((m) => ({
      id: m.id,
      timestamp: m.timestamp,
      body: m.body,
      attempts: m.attempts,
      ack: () => settle(m.id, "ack"),
      retry: (options?: QueueRetryOptions) => retry(m.id, options),
    }));
    const batch = {
      queue: "kopje",
      messages,
      ackAll: () => stored.forEach((m) => settle(m.id, "ack")),
      retryAll: (options?: QueueRetryOptions) => stored.forEach((m) => retry(m.id, options)),
    } as unknown as MessageBatch;
    let threw = false;
    try {
      await handler(batch);
    } catch {
      threw = true;
    }
    for (const m of stored) {
      const result = outcome.get(m.id) ?? (threw ? { delaySeconds: 0 } : "ack");
      if (result !== "ack") {
        this.retries++;
        const next = { ...m, attempts: m.attempts + 1, retries: m.retries + 1, delaySeconds: result.delaySeconds };
        (next.retries > MAX_RETRIES ? this.dropped : this.pending).push(next);
      }
    }
  }
}
