// A default (not byte) stream over `chunks` that counts its pulls, those after a cancel among them, and records the
// cancel; with `stall`, it never ends after the last chunk. Shared by test/body-prefix.test.ts and
// test/web-page.test.ts.
export function trackedStream(chunks: Uint8Array[], stall = false) {
  const state = { pulls: 0, pullsAfterCancel: 0, cancelled: false };
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls++;
      if (state.cancelled) {
        state.pullsAfterCancel++;
      }
      const chunk = chunks[index++];
      if (chunk !== undefined) {
        controller.enqueue(chunk);
      } else if (stall) {
        return new Promise<void>(() => {});
      } else {
        controller.close();
      }
      return undefined;
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}
