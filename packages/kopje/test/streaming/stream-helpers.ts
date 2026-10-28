import type { ApiHarness } from "../api-helpers";
import { BUILD } from "../helpers";

// Sockets of the streaming API in tests. A test opens them through the real app (h.request) on its own harness, whose
// Store has a name of its own (helpers.ts freshStore), and waits only for what arrives on them and for the drain
// barrier (Store streamDrained), never for a fixed time; the suite's testTimeout guards every wait.

export type StreamMessage = { stream?: string[]; event?: string; payload?: string; error?: string; status?: number };

// What arrives on one socket: every message in order, and its close.
export class Inbox {
  readonly messages: StreamMessage[] = [];
  readonly #taken = new Set<number>();
  #close: { code: number; reason: string } | null = null;
  #waiters: (() => void)[] = [];

  constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      this.messages.push(JSON.parse(event.data as string) as StreamMessage);
      this.#wake();
    });
    ws.addEventListener("close", (event) => {
      this.#close = { code: event.code, reason: event.reason };
      this.#wake();
    });
  }

  // The next message not yet taken that matches, once it arrives; the ones skipped before it stay to be taken.
  async next(predicate: (message: StreamMessage) => boolean = () => true): Promise<StreamMessage> {
    for (;;) {
      const index = this.messages.findIndex((message, i) => !this.#taken.has(i) && predicate(message));
      if (index !== -1) {
        this.#taken.add(index);
        return this.messages[index]!;
      }
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }

  // The messages not yet taken.
  rest(): StreamMessage[] {
    return this.messages.filter((_, i) => !this.#taken.has(i));
  }

  async closed(): Promise<{ code: number; reason: string }> {
    while (this.#close === null) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    return this.#close;
  }

  get isClosed(): boolean {
    return this.#close !== null;
  }

  send(message: unknown): void {
    this.ws.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  #wake(): void {
    for (const resolve of this.#waiters.splice(0)) {
      resolve();
    }
  }
}

export type Via = "protocol" | "header" | "query";

// An upgrade of /api/v1/streaming with the token where `via` says (masto.js sends it as the subprotocol).
export function upgrade(
  h: Pick<ApiHarness, "request">,
  token: string | null,
  options: { via?: Via; query?: string; path?: string } = {},
): Promise<Response> {
  const via = options.via ?? "protocol";
  const headers: Record<string, string> = { upgrade: "websocket" };
  const query = new URLSearchParams(options.query ?? "");
  if (token !== null) {
    if (via === "protocol") {
      headers["sec-websocket-protocol"] = token;
    } else if (via === "header") {
      headers.authorization = `Bearer ${token}`;
    } else {
      query.set("access_token", token);
    }
  }
  const search = query.size === 0 ? "" : `?${query.toString()}`;
  return h.request(`${options.path ?? "/api/v1/streaming"}${search}`, { headers });
}

// An open socket, accepted, with its inbox.
export async function connect(
  h: Pick<ApiHarness, "request">,
  token: string,
  options: { via?: Via; query?: string; path?: string } = {},
): Promise<Inbox> {
  const response = await upgrade(h, token, options);
  if (response.status !== 101 || response.webSocket === null) {
    throw new Error(`upgrade failed: ${response.status} ${response.headers.get("x-error-message")}`);
  }
  response.webSocket.accept();
  return new Inbox(response.webSocket);
}

// A socket subscribed to `streams`, each subscription in effect once the drain barrier returns.
export async function subscribed(
  h: Pick<ApiHarness, "request" | "store">,
  token: string,
  ...streams: string[]
): Promise<Inbox> {
  const inbox = await connect(h, token);
  for (const stream of streams) {
    inbox.send({ type: "subscribe", stream });
  }
  await settled(h, inbox);
  return inbox;
}

// A round trip on one socket: an unsubscribe of an unknown stream answers an error, which arrives after everything the
// Store sent on the socket before it, and after the Store handled everything the socket sent before it (a subscribe
// echoes nothing). The error is taken.
export async function echo(inbox: Inbox): Promise<void> {
  inbox.send({ type: "unsubscribe", stream: "kopje-test-barrier" });
  await inbox.next((message) => message.error === "Error unsubscribing from channel");
}

// What this socket sent is in effect, and the fan-out has caught up.
export async function settled(h: Pick<ApiHarness, "store">, inbox: Inbox): Promise<void> {
  await echo(inbox);
  await drained(h, inbox);
}

// The drain barrier: no turn runs or is requested and the fan-out is at the journal's head (Store streamDrained), and
// then a round trip on each open socket given, so what the turns sent them has arrived. Returns the turns this Store
// instance has run.
export async function drained(h: Pick<ApiHarness, "store">, ...inboxes: Inbox[]): Promise<{ turns: number }> {
  const result = await h.store.streamDrained(BUILD);
  for (const inbox of inboxes) {
    await echo(inbox);
  }
  return result;
}

// Takes every message left on a socket.
export async function takeAll(inbox: Inbox): Promise<void> {
  for (let left = inbox.rest().length; left > 0; left--) {
    await inbox.next();
  }
}

// The notifications in a stream's messages, parsed, in order.
export function notifications(messages: readonly StreamMessage[], stream: string): { id: string; type: string }[] {
  return messages
    .filter((message) => message.event === "notification" && message.stream?.[0] === stream)
    .map((message) => JSON.parse(message.payload ?? "") as { id: string; type: string });
}
