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
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false`,
  `CREATE TABLE IF NOT EXISTS teams (
     id         SERIAL PRIMARY KEY,
     name       TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS team_members (
     team_id    INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
     user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     role       TEXT NOT NULL CHECK (role IN ('admin', 'member')),
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (team_id, user_id)
   )`,
  `CREATE INDEX IF NOT EXISTS team_members_user_idx ON team_members (user_id)`,
];

export async function createSchema(db: Db): Promise<void> {
  for (const sql of statements) await db.query(sql);
}
