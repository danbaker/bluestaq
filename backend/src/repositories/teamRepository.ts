import { withTransaction, type Db, type Queryable } from "../db/client.js";

export type Role = "admin" | "member";

export interface Team {
  id: number;
  name: string;
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
        const { rows } = await tx.query<Team>("INSERT INTO teams (name) VALUES ($1) RETURNING id, name", [name]);
        await tx.query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'admin')", [
          rows[0].id,
          creatorId,
        ]);
        return { ...rows[0], role: "admin" as const };
      });
    },

    async listForUser(userId: number): Promise<TeamWithRole[]> {
      const { rows } = await db.query<TeamWithRole>(
        `SELECT t.id, t.name, m.role
           FROM teams t JOIN team_members m ON m.team_id = t.id
          WHERE m.user_id = $1
          ORDER BY t.name, t.id`,
        [userId],
      );
      return rows;
    },

    /** The user's role in the team, or null if not a member. */
    getRole: (teamId: number, userId: number) => roleIn(db, teamId, userId),

    async findById(teamId: number): Promise<Team | null> {
      const { rows } = await db.query<Team>("SELECT id, name FROM teams WHERE id = $1", [teamId]);
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
      await db.query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)", [
        teamId,
        userId,
        role,
      ]);
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
