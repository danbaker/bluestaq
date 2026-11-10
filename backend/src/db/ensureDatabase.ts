import pg from "pg";

/** Creates the target database if it does not exist yet (connects via the "postgres" maintenance db). */
export async function ensureDatabase(connectionString: string): Promise<void> {
  const url = new URL(connectionString);
  const dbName = decodeURIComponent(url.pathname.slice(1));
  if (!/^[A-Za-z0-9_]+$/.test(dbName)) throw new Error(`Unsafe database name: ${dbName}`);

  url.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (!rowCount) {
      try {
        await admin.query(`CREATE DATABASE "${dbName}"`);
      } catch (err) {
        // 42P04 duplicate_database, 23505 unique_violation: another process created it first.
        const code = (err as { code?: string }).code;
        if (code !== "42P04" && code !== "23505") throw err;
      }
    }
  } finally {
    await admin.end();
  }
}
