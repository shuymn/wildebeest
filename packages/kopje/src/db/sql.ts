type Row = Record<string, SqlStorageValue>

// Thin typed access to the Store's SQLite. Only used inside a Store transaction.
export class Db {
	constructor(private readonly sql: SqlStorage) {}

	all<T extends Row>(query: string, ...params: SqlStorageValue[]): T[] {
		return this.sql.exec<T>(query, ...params).toArray()
	}

	first<T extends Row>(query: string, ...params: SqlStorageValue[]): T | undefined {
		return this.all<T>(query, ...params)[0]
	}

	run(query: string, ...params: SqlStorageValue[]): number {
		return this.sql.exec(query, ...params).rowsWritten
	}
}
