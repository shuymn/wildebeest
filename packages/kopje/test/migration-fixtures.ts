// Undeclared rebuilds that break a reference, each applied after its fixture. test/migrations.test.ts ('Store
// migration runner') shows the whole-Store check refuses each; test/migration-lint.test.ts shows that declaring either
// one unchanged fails the lint.
export const BREAK_WITNESSES = [
  {
    label: "a populated child whose parent is dropped and recreated behind an external unique index",
    fixture: `CREATE TABLE fk_p (id TEXT); CREATE UNIQUE INDEX fk_p_key ON fk_p (id);
			CREATE TABLE fk_c (pid TEXT REFERENCES fk_p (id));
			INSERT INTO fk_p VALUES ('a'); INSERT INTO fk_c VALUES ('a');`,
    breaking:
      "DROP INDEX fk_p_key; DROP TABLE fk_p; CREATE TABLE fk_p (id TEXT); CREATE UNIQUE INDEX fk_p_key ON fk_p (id);",
    detail: /violation\(s\)/,
  },
  {
    label: "a repeated rebuild that removes the inline key",
    fixture: "CREATE TABLE fk_q (id TEXT PRIMARY KEY); CREATE TABLE fk_d (qid TEXT REFERENCES fk_q (id));",
    breaking: `CREATE TABLE fk_q_next (id TEXT); INSERT INTO fk_q_next SELECT id FROM fk_q; DROP TABLE fk_q;
			ALTER TABLE fk_q_next RENAME TO fk_q;`.repeat(2),
    detail: /foreign key mismatch/,
  },
];
