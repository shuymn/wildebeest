import { describe, expect, it } from "vitest";

import { isUnicodeEmoji } from "../src/platform/emoji-names";

// The Unicode emoji an announcement reaction may be named by (platform/emoji-names.ts), as workerd's ICU judges them:
// RGI emoji and their unqualified forms (Mastodon's emoji_map.json keys are both), nothing else, within 128 bytes.

describe("isUnicodeEmoji", () => {
  const accepted: [string, string][] = [
    ["thumbs up", "\u{1F44D}"],
    ["heart, unqualified", "❤"],
    ["heart, fully qualified", "❤️"],
    ["keycap one, unqualified", "1⃣"],
    ["keycap one, fully qualified", "1️⃣"],
    ["family (ZWJ sequence)", "\u{1F468}‍\u{1F469}‍\u{1F467}"],
    ["man lifting weights, toned, unqualified", "\u{1F3CB}\u{1F3FC}‍♂"],
    ["flag of Japan", "\u{1F1EF}\u{1F1F5}"],
    ["flag of England (tag sequence)", "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}"],
    ["copyright sign, unqualified", "©"],
  ];
  it.each(accepted)("accepts %s", (_label, name) => {
    expect(isUnicodeEmoji(name)).toBe(true);
    // Every accepted name holds a code point past ASCII (the CHECK of a reaction without a custom emoji).
    expect([...name].some((point) => (point.codePointAt(0) ?? 0) > 0x7f)).toBe(true);
  });

  const refused: [string, string][] = [
    ["a letter", "a"],
    ["a digit", "1"],
    ["a number sign", "#"],
    ["two hearts", "❤❤"],
    ["markup", "<b>"],
    ["a space", " "],
    ["the empty name", ""],
    ["an ideographic space", "　"],
    ["a lone selector", "️"],
    ["a letter with a skin tone", "a\u{1F3FC}"],
    ["a lone surrogate", "\uD83D"],
    ["129 bytes: thirty-two faces and a letter", "\u{1F600}".repeat(32) + "a"],
  ];
  it.each(refused)("refuses %s", (_label, name) => {
    expect(isUnicodeEmoji(name)).toBe(false);
  });
});
