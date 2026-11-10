import { newDb } from "pg-mem";
import type { Db } from "./client.js";
import { createSchema } from "./schema.js";
import { seed } from "./seed.js";

export const TEST_SECRET = "test-secret";
export const TEST_USER = { username: "admin", password: "admin123" };

/** In-memory Postgres (pg-mem), migrated and seeded. For tests only. */
export async function createTestDb(): Promise<Db> {
  const { Pool } = newDb().adapters.createPg();
  const db = new Pool() as Db;
  await createSchema(db);
  await seed(db, { adminUsername: TEST_USER.username, adminPassword: TEST_USER.password });
  return db;
}

// ---------- real Postgres, for tests pg-mem cannot do ----------
// pg-mem corrupts every byte above 127 in a bytea column (Yjs state is full of them) and cannot lock
// rows, so persistence and race tests run against real Postgres in their own throwaway database.
import type { Pool } from "pg";
import { createPool } from "./client.js";
import { ensureDatabase } from "./ensureDatabase.js";

/** Connection URL for a test database named `dbName` on the local server (override with TEST_PGCONNECTIONSTRING). */
export function realTestDbUrl(dbName: string): string {
  const base = process.env.TEST_PGCONNECTIONSTRING ?? "postgresql://userx:pw@localhost:5432/postgres?sslmode=disable";
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  return url.toString();
}

const UNREACHABLE = new Set(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH"]);

/**
 * A pool on a real, schema-ready test database, or null if Postgres isn't running (tests should skip).
 * Any other failure (bad password, broken schema...) throws, so it can't hide behind a silent skip.
 */
export async function connectRealTestDb(dbName: string): Promise<Pool | null> {
  const url = realTestDbUrl(dbName);
  let pool: Pool | null = null;
  try {
    await ensureDatabase(url);
    pool = createPool(url);
    await pool.query("SELECT 1");
    await createSchema(pool);
    return pool;
  } catch (err) {
    await pool?.end().catch(() => {});
    const code = (err as { code?: string; errors?: { code?: string }[] }).code ?? (err as { errors?: { code?: string }[] }).errors?.[0]?.code;
    if (code && UNREACHABLE.has(code)) return null;
    throw err;
  }
}

/** Empties every table and re-seeds the admin, so each test starts clean. */
export async function resetRealTestDb(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
  if (rows.length) {
    await pool.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  }
  await seed(pool, { adminUsername: TEST_USER.username, adminPassword: TEST_USER.password });
}
