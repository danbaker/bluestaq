import type { Db } from "./client.js";

/**
 * Schema lives here. Every statement must be idempotent (IF NOT EXISTS),
 * because createSchema() runs on every startup. Order matters for foreign keys.
 *
 * Note: IF NOT EXISTS never alters an existing table. To change a live table,
 * add an idempotent statement like `ALTER TABLE users ADD COLUMN IF NOT EXISTS ...`.
 */
const statements: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
     id            SERIAL PRIMARY KEY,
     username      TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
];

export async function createSchema(db: Db): Promise<void> {
  for (const sql of statements) await db.query(sql);
}
