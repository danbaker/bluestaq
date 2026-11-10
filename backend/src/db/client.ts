import pg from "pg";

type QueryResult<T> = Promise<{ rows: T[]; rowCount: number | null }>;

/** Minimal DB surface the rest of the app depends on. A pg Pool (or pg-mem's) satisfies it. */
export interface Db {
  query<T extends pg.QueryResultRow = any>(text: string, params?: unknown[]): QueryResult<T>;
  /** Check out a dedicated connection. Needed for transactions. */
  connect(): Promise<{
    query<T extends pg.QueryResultRow = any>(text: string, params?: unknown[]): QueryResult<T>;
    release(): void;
  }>;
}

/** The query-only view handed to code running inside a transaction. */
export type Queryable = Pick<Db, "query">;

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}

/** Runs fn in a transaction: commits if it resolves, rolls back if it throws. */
export async function withTransaction<T>(db: Db, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
