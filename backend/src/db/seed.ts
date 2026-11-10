import bcrypt from "bcryptjs";
import type { Db } from "./client.js";
import { createUserRepository } from "../repositories/userRepository.js";

export interface SeedOptions {
  adminUsername: string;
  adminPassword: string;
}

/** Populates initial data. Idempotent: only inserts what is missing. */
export async function seed(db: Db, opts: SeedOptions): Promise<void> {
  const users = createUserRepository(db);
  const admin =
    (await users.findByUsername(opts.adminUsername)) ??
    (await users.create(opts.adminUsername, await bcrypt.hash(opts.adminPassword, 10)));
  if (!admin.isAdmin) await users.setAdmin(admin.id, true);
}
