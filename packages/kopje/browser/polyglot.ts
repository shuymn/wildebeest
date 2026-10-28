// A GIF that is also an HTML document (remote-media.spec.ts's inertness check): a valid 1×1 image, then markup and a
// script after its trailer. The cache strips anything past the trailer (platform/remote-media-bytes.ts), so this is the
// file it would never store, served anyway to show the route keeps it inert. The script, if it ran, would fetch
// RAN_PATH.

export const RAN_PATH = "/ran";

const GIF = [
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
  0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02,
  0x02, 0x44, 0x01, 0x00, 0x3b,
];

const HTML = `<!doctype html><html><body><h1 id="rendered">rendered</h1><script>fetch('${RAN_PATH}');document.title='ran';</script></body></html>`;

export const POLYGLOT: Uint8Array = Uint8Array.from([...GIF, ...new TextEncoder().encode(HTML)]);
