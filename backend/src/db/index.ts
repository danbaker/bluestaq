import type { Pool } from "pg";
import { config } from "../config.js";
import { createPool } from "./client.js";
import { ensureDatabase } from "./ensureDatabase.js";
import { createSchema } from "./schema.js";
import { seed } from "./seed.js";

/** Creates the database (if needed), applies migrations, seeds data, and returns a ready pool. */
export async function initDatabase(): Promise<Pool> {
  await ensureDatabase(config.databaseUrl);
  const pool = createPool(config.databaseUrl);
  await createSchema(pool);
  await seed(pool, {
    adminUsername: config.seedAdminUsername,
    adminPassword: config.seedAdminPassword,
  });
  return pool;
}

export type { Db } from "./client.js";
