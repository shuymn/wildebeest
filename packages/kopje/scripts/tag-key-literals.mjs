// Prints the literal sections of migrations/0087_tag_key_fixed_points.sql (the INSERT ... VALUES of tag_key_chars,
// tag_key_triggers, tag_nfc_pieces, tag_nfc_ccc and tag_nfc_pairs), derived from this Node's Unicode tables by
// test/tag-key-tables.ts with Kopje's normalizeOnce (src/domain/tag-name.ts), both run from the sources.
// test-node/tag-key-fixed-points.test.ts runs it and requires the migration to hold its output, so a runtime whose
// tables differ from the released file's fails there.
//
//   node scripts/tag-key-literals.mjs

import { normalizeOnce } from "../src/domain/tag-name.ts";
import { deriveTagKeyTables, tagKeyLiterals, tagKeyRows } from "../test/tag-key-tables.ts";

process.stdout.write(tagKeyLiterals(tagKeyRows(deriveTagKeyTables(normalizeOnce))));
