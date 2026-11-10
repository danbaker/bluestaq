import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TEST_USER } from "../db/testDb.js";
import { setupTestServer } from "../testApp.js";

let ctx: Awaited<ReturnType<typeof setupTestServer>>;
beforeEach(async () => {
  ctx = await setupTestServer();
});
afterEach(async () => {
  await ctx.close();
});

const eventually = <T>(fn: () => T | Promise<T>) => vi.waitFor(fn, { timeout: 3000, interval: 20 });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function alicesPrivateNote() {
  const alice = await ctx.as("alice");
  const space = ((await alice.agent.get("/api/teams")).body as { id: number; personal: boolean }[]).find((t) => t.personal)!;
  const noteId = (await alice.agent.post(`/api/teams/${space.id}/notes`).send({ title: "Diary" })).body.id as string;
  return { alice, space, noteId };
}

describe("live editing of a private note", () => {
  it("the owner's tabs all see each other's edits, just like a team note", async () => {
    const { alice, noteId } = await alicesPrivateNote();
    const tab1 = ctx.openNote(alice.cookie, noteId);
    const tab2 = ctx.openNote(alice.cookie, noteId);
    const tab3 = ctx.openNote(alice.cookie, noteId);
    expect(await Promise.all([tab1.outcome, tab2.outcome, tab3.outcome])).toEqual(["allowed", "allowed", "allowed"]);

    tab1.text.insert(0, "dear diary");
    await eventually(() => {
      expect(tab2.text.toString()).toBe("dear diary");
      expect(tab3.text.toString()).toBe("dear diary");
    });
    tab3.text.insert(tab3.text.length, ", hello");
    await eventually(() => expect(tab1.text.toString()).toBe("dear diary, hello"));
    await eventually(async () =>
      expect((await alice.agent.get(`/api/notes/${noteId}/presence`)).body).toEqual([expect.objectContaining({ username: "alice", tabs: 3 })]),
    );
  });

  it("nobody else can open it: not a teammate, not a stranger, not the site admin", async () => {
    const { alice, noteId } = await alicesPrivateNote();
    const bob = await ctx.as("bob");
    const teamId = (await alice.agent.post("/api/teams").send({ name: "Shared" })).body.id as number;
    await alice.agent.post(`/api/teams/${teamId}/members`).send({ username: "bob" });
    const admin = await ctx.as(TEST_USER.username, TEST_USER.password);

    const owner = ctx.openNote(alice.cookie, noteId);
    await owner.outcome;
    owner.text.insert(0, "top secret");
    await eventually(async () => expect(owner.provider.hasUnsyncedChanges).toBe(false));

    for (const other of [bob, await ctx.as("carol"), admin]) {
      const intruder = ctx.openNote(other.cookie, noteId);
      expect(await intruder.outcome).toBe("denied");
      await pause(150);
      expect(intruder.text.toString()).toBe("");
    }
  });
});
