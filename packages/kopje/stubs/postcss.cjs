// Stands in for postcss, which sanitize-html loads only to parse style attributes. Kopje never allows a style
// attribute (src/security/html.ts), so the parser is never called; leaving it out keeps about 40 KiB of CSS tooling,
// and its Node-only source-map dependencies, out of the Worker. sanitize-html drops the attribute if this throws.
"use strict";

module.exports = {
  parse() {
    throw new Error("postcss is not bundled: style attributes are never allowed");
  },
};
