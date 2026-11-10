import type { Db } from "../db/client.js";

export interface User {
  id: number;
  username: string;
  passwordHash: string;
}

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
}

const toUser = (r: UserRow): User => ({ id: r.id, username: r.username, passwordHash: r.password_hash });

export function createUserRepository(db: Db) {
  return {
    async findByUsername(username: string): Promise<User | null> {
      const { rows } = await db.query<UserRow>(
        "SELECT id, username, password_hash FROM users WHERE username = $1",
        [username],
      );
      return rows[0] ? toUser(rows[0]) : null;
    },
    async findById(id: number): Promise<User | null> {
      const { rows } = await db.query<UserRow>(
        "SELECT id, username, password_hash FROM users WHERE id = $1",
        [id],
      );
      return rows[0] ? toUser(rows[0]) : null;
    },
    async create(username: string, passwordHash: string): Promise<User> {
      const { rows } = await db.query<UserRow>(
        "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, password_hash",
        [username, passwordHash],
      );
      return toUser(rows[0]);
    },
  };
}

export type UserRepository = ReturnType<typeof createUserRepository>;
