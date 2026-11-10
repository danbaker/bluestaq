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
