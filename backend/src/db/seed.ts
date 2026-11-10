import bcrypt from "bcryptjs";
import type { Db } from "./client.js";
import { createTeamRepository } from "../repositories/teamRepository.js";
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
  await ensurePersonalTeams(db); // also gives users who existed before private notes their private space
}

/** Every user gets a private space. Idempotent, so it runs on every boot and fills in any that are missing. */
export async function ensurePersonalTeams(db: Db): Promise<void> {
  const teams = createTeamRepository(db);
  for (const id of await teams.usersNeedingPersonalTeam()) await teams.ensurePersonalTeam(id);
}
