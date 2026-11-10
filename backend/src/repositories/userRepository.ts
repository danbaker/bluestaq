import type { Db } from "../db/client.js";

export interface User {
  id: number;
  username: string;
  passwordHash: string;
  /** Site admin: may create users. */
  isAdmin: boolean;
}

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  is_admin: boolean;
}

const COLUMNS = "id, username, password_hash, is_admin";
const toUser = (r: UserRow): User => ({
  id: r.id,
  username: r.username,
  passwordHash: r.password_hash,
  isAdmin: r.is_admin,
});

/** Usernames are case-insensitive: always stored and looked up lowercase, so "Alice" and "alice" can't coexist. */
export const normalizeUsername = (username: string): string => username.trim().toLowerCase();

export function createUserRepository(db: Db) {
  return {
    async findByUsername(username: string): Promise<User | null> {
      const { rows } = await db.query<UserRow>(`SELECT ${COLUMNS} FROM users WHERE username = $1`, [
        normalizeUsername(username),
      ]);
      return rows[0] ? toUser(rows[0]) : null;
    },
    async findById(id: number): Promise<User | null> {
      const { rows } = await db.query<UserRow>(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
      return rows[0] ? toUser(rows[0]) : null;
    },
    /** Throws a unique violation (code 23505) if the username is taken. */
    async create(username: string, passwordHash: string): Promise<User> {
      const { rows } = await db.query<UserRow>(
        `INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING ${COLUMNS}`,
        [normalizeUsername(username), passwordHash],
      );
      return toUser(rows[0]);
    },
    async listIds(): Promise<number[]> {
      const { rows } = await db.query<{ id: number }>("SELECT id FROM users ORDER BY id");
      return rows.map((r) => r.id);
    },
    async setAdmin(id: number, isAdmin: boolean): Promise<void> {
      await db.query("UPDATE users SET is_admin = $2 WHERE id = $1", [id, isAdmin]);
    },
  };
}

export type UserRepository = ReturnType<typeof createUserRepository>;
