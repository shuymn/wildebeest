// Fake DOM nodes for the local-time rewrite (src/client/local-time.ts), shared by test-node/local-time.test.ts and the
// browser job's Node twin of the bundle: just what the rewrite may touch, and a record of what it did.

// An element the rewrite creates: its attributes and its text, which it may set only through setAttribute and
// textContent.
export class FakeElement {
  readonly attributes: Record<string, string> = {};
  textContent = "";
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
}

// A <time> as the rewrite sees it: its attributes, its content (one text node, or the elements the rewrite made), and
// every attribute write. textContent joins its content as the DOM does, which is also what a selection of the whole
// element copies; shown is what the eye sees and spoken the visually hidden full form.
export class FakeTime {
  content: (string | FakeElement)[];
  readonly writes: [name: string, value: string][] = [];
  readonly ownerDocument = { createElement: (tag: string) => new FakeElement(tag) };
  constructor(
    readonly attributes: Record<string, string>,
    text: string,
  ) {
    this.content = [text];
  }
  get textContent(): string {
    return this.content.map((node) => (typeof node === "string" ? node : node.textContent)).join("");
  }
  set textContent(text: string) {
    this.content = [text];
  }
  get shown(): string {
    const hidden = this.content.find((node) => typeof node !== "string" && node.attributes["aria-hidden"] === "true");
    return typeof hidden === "object" ? hidden.textContent : this.textContent;
  }
  get spoken(): string | null {
    const vh = this.content.find((node) => typeof node !== "string" && node.attributes.class === "vh");
    return typeof vh === "object" ? vh.textContent : null;
  }
  replaceChildren(...nodes: FakeElement[]): void {
    this.content = nodes;
  }
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.writes.push([name, value]);
  }
}

// A document holding the times; it answers only the rewrite's selector, as a browser would.
export function fakePage(times: FakeTime[]): ParentNode {
  return {
    querySelectorAll(selector: string) {
      if (selector !== "time[data-local]") {
        throw new Error(`unexpected selector ${selector}`);
      }
      return times.filter((time) => "data-local" in time.attributes);
    },
  } as unknown as ParentNode;
}
