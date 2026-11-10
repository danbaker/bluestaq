import { withTransaction, type Db, type Queryable } from "../db/client.js";

export type Role = "admin" | "member";

export const PERSONAL_TEAM_NAME = "Private";

export interface Team {
  id: number;
  name: string;
  /** A user's private space (only they belong to it), not a shared team. */
  personal: boolean;
}
export interface TeamWithRole extends Team {
  role: Role;
}
export interface Member {
  userId: number;
  username: string;
  role: Role;
}

async function roleIn(q: Queryable, teamId: number, userId: number): Promise<Role | null> {
  const { rows } = await q.query<{ role: Role }>(
    "SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2",
    [teamId, userId],
  );
  return rows[0]?.role ?? null;
}

async function countAdmins(q: Queryable, teamId: number): Promise<number> {
  const { rows } = await q.query<{ n: string | number }>(
    "SELECT count(*) AS n FROM team_members WHERE team_id = $1 AND role = 'admin'",
    [teamId],
  );
  return Number(rows[0].n);
}

export function createTeamRepository(db: Db) {
  return {
    /** Creates the team and makes the creator its admin, atomically. */
    async create(name: string, creatorId: number): Promise<TeamWithRole> {
      return withTransaction(db, async (tx) => {
        const { rows } = await tx.query<{ id: number; name: string }>(
          "INSERT INTO teams (name) VALUES ($1) RETURNING id, name",
          [name],
        );
        await tx.query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'admin')", [
          rows[0].id,
          creatorId,
        ]);
        return { ...rows[0], personal: false, role: "admin" as const };
      });
    },

    async listForUser(userId: number): Promise<TeamWithRole[]> {
      const { rows } = await db.query<TeamWithRole>(
        `SELECT t.id, t.name, (t.personal_owner_id IS NOT NULL) AS personal, m.role
           FROM teams t JOIN team_members m ON m.team_id = t.id
          WHERE m.user_id = $1
          ORDER BY (t.personal_owner_id IS NULL), lower(t.name), t.name, t.id`, // the private space always comes first
        [userId],
      );
      return rows;
    },

    /**
     * Makes sure the user has their private space (a one-person team named "Private"), and returns its id.
     * Safe to call any number of times, including at the same moment from two places.
     */
    async ensurePersonalTeam(userId: number): Promise<number> {
      const find = async (q: Queryable) =>
        (await q.query<{ id: number }>("SELECT id FROM teams WHERE personal_owner_id = $1", [userId])).rows[0]?.id;
      // Almost always it already exists (this runs at every login): one query, no transaction.
      const existing = await find(db);
      if (existing !== undefined && (await roleIn(db, existing, userId))) return existing;
      try {
        return await withTransaction(db, async (tx) => {
          const teamId =
            (await find(tx)) ??
            (
              await tx.query<{ id: number }>(
                "INSERT INTO teams (name, personal_owner_id) VALUES ($1, $2) RETURNING id",
                [PERSONAL_TEAM_NAME, userId],
              )
            ).rows[0].id;
          if (!(await roleIn(tx, teamId, userId))) {
            await tx.query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'admin')", [teamId, userId]);
          }
          return teamId;
        });
      } catch (err) {
        // Two callers raced to create it: the unique index let one win. Use theirs.
        if ((err as { code?: string }).code === "23505") {
          const existing = await find(db);
          if (existing) return existing;
        }
        throw err;
      }
    },

    /** The user's role in the team, or null if not a member. */
    getRole: (teamId: number, userId: number) => roleIn(db, teamId, userId),

    /** Role and whether it is a private space, in one query. Null if the user is not a member. */
    async getMembership(teamId: number, userId: number): Promise<{ role: Role; personal: boolean } | null> {
      const { rows } = await db.query<{ role: Role; personal: boolean }>(
        `SELECT m.role, (t.personal_owner_id IS NOT NULL) AS personal
           FROM team_members m JOIN teams t ON t.id = m.team_id
          WHERE m.team_id = $1 AND m.user_id = $2`,
        [teamId, userId],
      );
      return rows[0] ?? null;
    },

    /** Ids of users whose private space is missing, or has lost its owner's membership. Two queries, however many users. */
    async usersNeedingPersonalTeam(): Promise<number[]> {
      const all = await db.query<{ id: number }>("SELECT id FROM users ORDER BY id");
      const ok = await db.query<{ user_id: number }>(
        `SELECT m.user_id FROM teams t
           JOIN team_members m ON m.team_id = t.id AND m.user_id = t.personal_owner_id
          WHERE t.personal_owner_id IS NOT NULL`,
      );
      const have = new Set(ok.rows.map((r) => r.user_id));
      return all.rows.map((r) => r.id).filter((id) => !have.has(id));
    },

    async findById(teamId: number): Promise<Team | null> {
      const { rows } = await db.query<Team>(
        "SELECT id, name, (personal_owner_id IS NOT NULL) AS personal FROM teams WHERE id = $1",
        [teamId],
      );
      return rows[0] ?? null;
    },

    async listMembers(teamId: number): Promise<Member[]> {
      const { rows } = await db.query<{ user_id: number; username: string; role: Role }>(
        `SELECT m.user_id, u.username, m.role
           FROM team_members m JOIN users u ON u.id = m.user_id
          WHERE m.team_id = $1
          ORDER BY u.username`,
        [teamId],
      );
      return rows.map((r) => ({ userId: r.user_id, username: r.username, role: r.role }));
    },

    async addMember(teamId: number, userId: number, role: Role): Promise<void> {
      // One statement, so the rule can't be raced: a private space never gets anyone but its owner.
      const { rowCount } = await db.query(
        `INSERT INTO team_members (team_id, user_id, role)
         SELECT CAST($1 AS integer), CAST($2 AS integer), CAST($3 AS text)
          WHERE NOT EXISTS (SELECT 1 FROM teams WHERE id = CAST($1 AS integer) AND personal_owner_id IS NOT NULL AND personal_owner_id <> CAST($2 AS integer))`,
        [teamId, userId, role],
      );
      if (!rowCount) throw new Error("A private space cannot have other members");
    },

    countAdmins: (teamId: number) => countAdmins(db, teamId),

    /**
     * Removes a member unless they are the team's last admin. The team row is locked for the
     * duration, so two concurrent removals can't both pass the check.
     */
    async removeMember(teamId: number, userId: number): Promise<"removed" | "not_found" | "last_admin"> {
      return withTransaction(db, async (tx) => {
        await tx.query("SELECT id FROM teams WHERE id = $1 FOR UPDATE", [teamId]);
        const role = await roleIn(tx, teamId, userId);
        if (!role) return "not_found";
        if (role === "admin" && (await countAdmins(tx, teamId)) <= 1) return "last_admin";
        await tx.query("DELETE FROM team_members WHERE team_id = $1 AND user_id = $2", [teamId, userId]);
        return "removed";
      });
    },

    /** Changes a member's role, refusing to demote the team's last admin. Same locking as removeMember. */
    async setRole(teamId: number, userId: number, newRole: Role): Promise<"updated" | "not_found" | "last_admin"> {
      return withTransaction(db, async (tx) => {
        await tx.query("SELECT id FROM teams WHERE id = $1 FOR UPDATE", [teamId]);
        const role = await roleIn(tx, teamId, userId);
        if (!role) return "not_found";
        if (role === "admin" && newRole !== "admin" && (await countAdmins(tx, teamId)) <= 1) return "last_admin";
        await tx.query("UPDATE team_members SET role = $3 WHERE team_id = $1 AND user_id = $2", [
          teamId,
          userId,
          newRole,
        ]);
        return "updated";
      });
    },
  };
}

export type TeamRepository = ReturnType<typeof createTeamRepository>;
