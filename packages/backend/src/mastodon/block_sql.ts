export function blockBetweenSql(accountIdExpression: string, targetAccountIdExpression: string): string {
	return `
	(account_id = ${accountIdExpression} AND target_account_id = ${targetAccountIdExpression})
	OR (account_id = ${targetAccountIdExpression} AND target_account_id = ${accountIdExpression})
	`
}

export function noBlockBetweenSql(accountIdExpression: string, targetAccountIdExpression: string): string {
	return `
	NOT EXISTS (
		SELECT 1 FROM blocks
		WHERE ${blockBetweenSql(accountIdExpression, targetAccountIdExpression)}
	)
	`
}
