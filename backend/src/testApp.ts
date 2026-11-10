import { expect } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { createApp } from "./app.js";
import { createTestDb, TEST_SECRET } from "./db/testDb.js";
import { createUserRepository } from "./repositories/userRepository.js";

export const PASSWORD = "password123";

/** Fresh app + in-memory DB with users alice, bob, carol. `as(name)` returns a logged-in supertest agent. */
export async function setupTestApp() {
  const db = await createTestDb();
  const hash = await bcrypt.hash(PASSWORD, 4);
  const users = createUserRepository(db);
  for (const name of ["alice", "bob", "carol"]) await users.create(name, hash);
  const app = createApp({ db, jwtSecret: TEST_SECRET });

  const as = async (username: string, password = PASSWORD) => {
    const agent = request.agent(app);
    const res = await agent.post("/api/auth/login").send({ username, password });
    expect(res.status).toBe(200);
    return agent;
  };
  return { app, db, as };
}
