// The moderation round bounds remote-suspension.ts shares with suspension.ts. Imports nothing, so they are
// initialized whatever the import order.

// Reports a suspension round reads at most.
export const REPORT_ROUND = 100;
// Rows any round writes at most: REACH_ROUND (suspension.ts) staged inboxes (or their deletion), the chunks they make,
// the job's own rows (its update or delete, and its Update's release), and its retry state's row
// (JOB_BOOKKEEPING_ROWS). A staging or writing round stays below it by construction (test/admin-suspension.test.ts
// measures it, a due retry's reset included); a severing round reserves the row from its budget (remote-suspension.ts).
export const MODERATION_ROUND_ROWS = 600;
