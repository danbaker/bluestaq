import { expect } from "vitest";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import WebSocket from "ws";
import * as Y from "yjs";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { createServer } from "./server.js";
import request from "supertest";
import bcrypt from "bcryptjs";
import { createApp } from "./app.js";
import type { Pool } from "pg";
import { createTestDb, resetRealTestDb, TEST_SECRET } from "./db/testDb.js";
import { ensurePersonalTeams } from "./db/seed.js";
import { createUserRepository } from "./repositories/userRepository.js";

export const PASSWORD = "password123";

/** Fresh app + in-memory DB with users alice, bob, carol. `as(name)` returns a logged-in supertest agent. */
export async function setupTestApp() {
  const db = await createTestDb();
  const hash = await bcrypt.hash(PASSWORD, 4);
  const users = createUserRepository(db);
  for (const name of ["alice", "bob", "carol"]) await users.create(name, hash);
  await ensurePersonalTeams(db);
  const app = createApp({ db, jwtSecret: TEST_SECRET });

  const as = async (username: string, password = PASSWORD) => {
    const agent = request.agent(app);
    const res = await agent.post("/api/auth/login").send({ username, password });
    expect(res.status).toBe(200);
    return agent;
  };
  return { app, db, as };
}

// ---------- real HTTP + WebSocket server, for realtime tests ----------

export const TEST_ORIGIN = "http://app.test";

/**
 * Real HTTP + WebSocket server on an ephemeral port, with users alice/bob/carol. Call close() when done.
 * Pass `realDb` (see connectRealTestDb) to use real Postgres instead of the in-memory one;
 * its tables are emptied first. The caller owns the pool and must end it.
 */
export async function setupTestServer(opts: { heartbeatMs?: number; saveDelayMs?: number; realDb?: Pool } = {}) {
  if (opts.realDb) await resetRealTestDb(opts.realDb);
  const db = opts.realDb ?? (await createTestDb());
  const hash = await bcrypt.hash(PASSWORD, 4);
  const users = createUserRepository(db);
  for (const name of ["alice", "bob", "carol"]) await users.create(name, hash);
  await ensurePersonalTeams(db);

  const startServer = async () => {
    const created = createServer({
      db,
      jwtSecret: TEST_SECRET,
      clientOrigin: TEST_ORIGIN,
      heartbeatMs: opts.heartbeatMs,
      saveDelayMs: opts.saveDelayMs ?? 50,
    });
    await new Promise<void>((resolve) => created.server.listen(0, "127.0.0.1", resolve));
    return { ...created, port: (created.server.address() as AddressInfo).port };
  };
  let running = await startServer();
  const urlOf = () => `ws://127.0.0.1:${running.port}/ws`;

  /** Logged-in REST agent plus the raw session cookie (for opening sockets). */
  const as = async (username: string, password = PASSWORD) => {
    const agent = request.agent(running.server);
    const res = await agent.post("/api/auth/login").send({ username, password });
    expect(res.status).toBe(200);
    const cookie = (res.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
    return { agent, cookie };
  };

  const cleanups: (() => void)[] = [];

  /** A WebSocket class that sends the given cookie (and optional Origin) on connect. */
  const socketClass = (cookie?: string, origin?: string) =>
    class extends WebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}) } });
      }
    };

  /** Opens a note like a browser tab would. `outcome` settles once the server accepts or refuses it. */
  function openNote(
    cookie: string,
    noteName: string,
    opts: { socket?: HocuspocusProviderWebsocket; sessionAwareness?: boolean } = {},
  ) {
    const doc = new Y.Doc();
    let settle!: (v: "allowed" | "denied") => void;
    const outcome = new Promise<"allowed" | "denied">((r) => (settle = r));
    const provider = new HocuspocusProvider({
      ...(opts.socket ? { websocketProvider: opts.socket } : { url: urlOf(), WebSocketPolyfill: socketClass(cookie) }),
      name: noteName,
      document: doc,
      ...(opts.sessionAwareness ? { sessionAwareness: true } : {}), // lets one socket carry the same note twice
      token: "unused", // identity comes from the session cookie; the provider just needs to send something
      onAuthenticated: () => settle("allowed"),
      onAuthenticationFailed: () => settle("denied"),
    });
    if (opts.socket) provider.attach();
    cleanups.push(() => provider.destroy());
    return { doc, text: doc.getText("content"), provider, outcome };
  }

  /** A bare socket (one tab with no notes open yet), for testing connection-level behavior. */
  function openSocket(cookie: string) {
    const ws = new WebSocket(urlOf(), { headers: { Cookie: cookie } });
    ws.on("error", () => {});
    cleanups.push(() => ws.terminate());
    const opened = new Promise<void>((resolve) => ws.once("open", () => resolve()));
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
    );
    return { ws, opened, closed };
  }

  /** One shared socket (one browser tab) that can carry several notes. */
  function openTab(cookie: string) {
    const socket = new HocuspocusProviderWebsocket({ url: urlOf(), WebSocketPolyfill: socketClass(cookie) });
    cleanups.push(() => socket.destroy());
    return socket;
  }

  /** Raw upgrade attempt: resolves with the HTTP status that refused it, or "open". */
  function rawConnect(opts: { cookie?: string; origin?: string; path?: string } = {}) {
    return new Promise<number | "open">((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${running.port}${opts.path ?? "/ws"}`, {
        headers: { ...(opts.cookie ? { Cookie: opts.cookie } : {}), ...(opts.origin ? { Origin: opts.origin } : {}) },
      });
      ws.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
        ws.terminate();
      });
      ws.on("open", () => {
        resolve("open");
        ws.close();
      });
      ws.on("error", () => {});
    });
  }

  const sessionCookieFor = (userId: number, secret = TEST_SECRET, expiresIn: number = 3600) =>
    `session=${jwt.sign({ username: "x" }, secret, { subject: String(userId), expiresIn })}`;

  /** Stops the server (saving open notes, like a real shutdown) and starts a fresh one on the same database. */
  async function stopServer() {
    await running.realtime.close();
    running.server.closeAllConnections();
    await new Promise<void>((resolve) => running.server.close(() => resolve()));
  }
  async function restart() {
    await stopServer();
    running = await startServer();
  }

  return {
    db,
    get server() {
      return running.server;
    },
    get port() {
      return running.port;
    },
    get wsUrl() {
      return urlOf();
    },
    restart,
    get realtime() {
      return running.realtime;
    },
    openSocket,
    as,
    openNote,
    openTab,
    rawConnect,
    sessionCookieFor,
    async close() {
      cleanups.splice(0).forEach((fn) => fn());
      await stopServer();
    },
  };
}
