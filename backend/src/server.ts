import http from "node:http";
import type { Db } from "./db/client.js";
import { createApp } from "./app.js";
import { attachRealtime } from "./realtime/index.js";
import { createRepositories } from "./repositories/index.js";

export interface ServerOptions {
  db: Db;
  jwtSecret: string;
  secureCookie?: boolean;
  /** Browser origin allowed to open WebSockets. */
  clientOrigin: string;
  /** Socket ping interval in ms (default 30s). */
  heartbeatMs?: number;
  /** Delay before saving after the last edit (default 2s). */
  saveDelayMs?: number;
}

/** The HTTP server: the REST app plus the /ws live-sync socket. */
export function createServer({ db, jwtSecret, secureCookie, clientOrigin, heartbeatMs, saveDelayMs }: ServerOptions) {
  const repos = createRepositories(db);
  const app = createApp({ db, jwtSecret, secureCookie, repos });
  const server = http.createServer(app);
  const realtime = attachRealtime({
    server,
    jwtSecret,
    allowedOrigin: clientOrigin,
    notes: repos.notes,
    teams: repos.teams,
    heartbeatMs,
    saveDelayMs,
  });
  server.on("close", () => void realtime.close().catch(() => {})); // idempotent; errors surface via an explicit close()
  return { app, server, realtime };
}
