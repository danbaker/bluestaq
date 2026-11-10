import pg from "pg";

/** Minimal DB surface the rest of the app depends on. Pool and test doubles both satisfy it. */
export interface Db {
  query<T extends pg.QueryResultRow = any>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}
