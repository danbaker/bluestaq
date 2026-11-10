import type { Db } from "../db/client.js";
import { createNoteRepository } from "./noteRepository.js";
import { createTeamRepository } from "./teamRepository.js";
import { createUserRepository } from "./userRepository.js";

export function createRepositories(db: Db) {
  return { users: createUserRepository(db), teams: createTeamRepository(db), notes: createNoteRepository(db) };
}
export type Repositories = ReturnType<typeof createRepositories>;
