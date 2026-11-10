import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { Hocuspocus, type Connection } from "@hocuspocus/server";
import * as Y from "yjs";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { verifySession } from "../auth/jwt.js";
import { SESSION_COOKIE } from "../config.js";
import type { NoteRepository } from "../repositories/noteRepository.js";
import type { TeamRepository } from "../repositories/teamRepository.js";
import { extractText } from "./noteText.js";
import type { PresenceEntry, RealtimeControl } from "./control.js";

export const WS_PATH = "/ws";
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;
// Note ids are lowercase UUIDs. Requiring the canonical form means one note can never end up as
// two different live documents ("ABC..." vs "abc...").
const NOTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Attached to every connection (one per browser tab) when the socket is accepted. */
export interface ConnectionContext {
  userId: number;
  username: string;
  /** Identifies this socket (one browser tab) in the registry. */
  tabId: string;
}

// Close codes for our own kick-outs (4000-4999 are free for applications).
const SIGNED_OUT = { code: 4401, reason: "Session ended" };
const FORBIDDEN = { code: 4403, reason: "Forbidden" };

/** One note open in a tab. A tab may hold several of these for the same note, so each is tracked on its own. */
interface OpenNote {
  noteId: string;
  teamId: number;
  connection: Connection;
}

/** One open browser tab: its socket, and the notes it currently has open. */
interface Tab {
  userId: number;
  username: string;
  ws: WebSocket;
  open: Set<OpenNote>;
}

export interface RealtimeOptions {
  server: HttpServer;
  jwtSecret: string;
  /** Browser Origin allowed to open sockets. Requests with no Origin (non-browser clients) are allowed. */
  allowedOrigin: string;
  notes: NoteRepository;
  teams: TeamRepository;
  /** How often to ping sockets; one that misses a whole interval is dropped. Default 30s. */
  heartbeatMs?: number;
  /** Save a note this long after the last edit (default 2s), and at least every 10s while it is being edited. */
  saveDelayMs?: number;
  /** Save at least this often while a note is being edited non-stop (default 10s, never below saveDelayMs). */
  maxSaveDelayMs?: number;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const value = part.slice(i + 1).trim();
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(value);
    } catch {
      out[part.slice(0, i).trim()] = value;
    }
  }
  return out;
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}

function toWebRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
    else if (value !== undefined) headers.set(name, value);
  }
  // Host is client-controlled and not needed: only the headers and query string matter downstream.
  return new Request(`http://localhost${req.url?.startsWith("/") ? req.url : WS_PATH}`, { headers });
}

function reject(socket: Duplex, status: number, text: string) {
  socket.on("error", () => {});
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

const MAX_TIMER_MS = 2_000_000_000; // setTimeout breaks above ~24.8 days

/** Closes the socket when the login it was opened with expires (the cookie dies, so the socket must too). */
function closeAtExpiry(ws: WebSocket, expiresAtSeconds: number) {
  const handle: { timer?: NodeJS.Timeout } = {};
  const arm = () => {
    const remaining = expiresAtSeconds * 1000 - Date.now();
    if (remaining <= 0) return ws.close(SIGNED_OUT.code, SIGNED_OUT.reason);
    handle.timer = setTimeout(arm, Math.min(remaining, MAX_TIMER_MS)); // re-checks, so long lifetimes are fine
    handle.timer.unref();
  };
  arm();
  return handle;
}

/**
 * Live note sync over WebSocket at /ws (Yjs via Hocuspocus).
 *
 * Two gates:
 *  1. The HTTP upgrade needs a valid session cookie and an allowed Origin.
 *  2. Every note a tab opens is checked on its own (onAuthenticate): the note must exist and the
 *     user must be on its team. Hocuspocus runs this for every document before it creates the
 *     connection, so one tab's socket can carry many notes safely.
 *
 * One socket is one browser tab. The same user may hold many sockets, and the same note may be
 * open on many of them; they all share one server-side document.
 */
export function attachRealtime({ server, jwtSecret, allowedOrigin, notes, teams, heartbeatMs = 30_000, saveDelayMs = 2_000, maxSaveDelayMs = 10_000 }: RealtimeOptions) {
  // Every open socket (one per browser tab), and the notes each has open. Memory only.
  const tabs = new Map<string, Tab>();

  // Saves in progress, so close() can wait for them before the process exits; and any that failed.
  const saving = new Set<Promise<unknown>>();
  const failedSaves: unknown[] = [];

  const hocuspocus = new Hocuspocus({
    quiet: true,
    // A note counts as open in this tab once it has been authorized and loaded.
    async connected({ documentName, context, connection }) {
      const { tabId, teamId, userId } = context as ConnectionContext & { teamId: number };
      const tab = tabs.get(tabId);
      if (!tab) return;
      const open: OpenNote = { noteId: documentName, teamId, connection };
      tab.open.add(open);
      connection.onClose(() => tab.open.delete(open)); // exactly this connection, never a newer one for the same note
      // Access may have been revoked while the note was loading. Checking after registering means a
      // kick-out either found this entry above, or the check here catches it.
      const [note, role] = await Promise.all([notes.findById(documentName), teams.getRole(teamId, userId)]);
      if (!note || !role) connection.close(FORBIDDEN);
    },
    debounce: saveDelayMs,
    maxDebounce: Math.max(saveDelayMs, maxSaveDelayMs),
    // One server-side document per note, shared by every tab. It is loaded when the first tab opens...
    async onLoadDocument({ documentName, document }) {
      const saved = await notes.loadContent(documentName);
      if (!saved) return;
      try {
        Y.applyUpdate(document, saved);
      } catch (err) {
        // Refuse to open rather than start empty: the next save would overwrite the (damaged) data.
        console.error(`Note ${documentName} has unreadable saved content; not opening it`, err);
        throw err;
      }
    },
    // ...and saved after a pause in typing, and when the last tab closes (one save however many tabs).
    async onStoreDocument({ documentName, document }) {
      const save = notes.saveContent(documentName, Y.encodeStateAsUpdate(document), extractText(document));
      saving.add(save);
      try {
        await save; // false = note was deleted meanwhile; nothing to save to
      } catch (err) {
        console.error(`Failed to save note ${documentName}`, err);
        failedSaves.push(err);
        throw err;
      } finally {
        saving.delete(save);
      }
    },
    async onAuthenticate({ documentName, context }) {
      const { userId } = context as ConnectionContext;
      const note = NOTE_ID.test(documentName) ? await notes.findById(documentName) : null;
      const role = note ? await teams.getRole(note.teamId, userId) : null;
      // Missing note, wrong team and bad id are deliberately indistinguishable.
      if (!note || !role) throw new Error("permission-denied");
      return { noteId: note.id, teamId: note.teamId };
    },
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  const alive = new WeakSet<WebSocket>();

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      if (new URL(req.url ?? "/", "http://localhost").pathname !== WS_PATH) return reject(socket, 404, "Not Found");
      if (req.headers.origin && req.headers.origin !== allowedOrigin) return reject(socket, 403, "Forbidden");

      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      const session = token ? verifySession(jwtSecret, token) : null;
      if (!session) return reject(socket, 401, "Unauthorized");

      const context: ConnectionContext = {
        userId: Number(session.sub),
        username: session.username,
        tabId: randomUUID(),
      };
      const request = toWebRequest(req);
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        try {
          const connection = hocuspocus.handleConnection(ws, request, context);
          alive.add(ws);
          tabs.set(context.tabId, { userId: context.userId, username: context.username, ws, open: new Set() });
          const expiry = closeAtExpiry(ws, session.exp);
          ws.on("close", () => {
            clearTimeout(expiry.timer);
            tabs.delete(context.tabId);
          });
          ws.on("message", (data, isBinary) => {
            if (isBinary) connection.handleMessage(toBytes(data));
          });
          ws.on("close", (code, reason) => connection.handleClose({ code, reason: reason.toString() }));
          ws.on("pong", () => {
            alive.add(ws);
            connection.touch();
          });
          ws.on("error", () => {});
        } catch (err) {
          console.error("Failed to set up WebSocket connection", err);
          ws.terminate();
        }
      });
    } catch {
      // A malformed request must never crash the process.
      reject(socket, 400, "Bad Request");
    }
  };
  server.on("upgrade", onUpgrade);

  // Drop sockets that vanished without a close frame (laptop lid, dead network).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();

  let closing: Promise<void> | null = null;

  async function shutDown() {
    clearInterval(heartbeat);
    server.off("upgrade", onUpgrade);
    failedSaves.length = 0;
    hocuspocus.flushPendingStores();
    hocuspocus.closeConnections();
    wss.clients.forEach((c) => c.terminate());
    wss.close();
    // Saves start asynchronously (and closing the last connection triggers one more), so keep
    // waiting until nothing is saving and every document has been unloaded.
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setImmediate(r));
      if (saving.size) await Promise.allSettled([...saving]);
      else if (hocuspocus.getDocumentsCount() === 0) break;
    }
    if (failedSaves.length) throw new AggregateError(failedSaves, `${failedSaves.length} note save(s) failed during shutdown`);
  }

  const control: RealtimeControl = {
    presence(noteId) {
      const byUser = new Map<number, PresenceEntry>();
      for (const tab of tabs.values()) {
        if (![...tab.open].some((o) => o.noteId === noteId)) continue;
        const entry = byUser.get(tab.userId) ?? { userId: tab.userId, username: tab.username, tabs: 0 };
        entry.tabs += 1;
        byUser.set(tab.userId, entry);
      }
      return [...byUser.values()].sort((a, b) => a.username.localeCompare(b.username));
    },
    disconnectUser(userId) {
      for (const tab of tabs.values()) if (tab.userId === userId) tab.ws.close(SIGNED_OUT.code, SIGNED_OUT.reason);
    },
    removeUserFromTeam(userId, teamId) {
      for (const tab of tabs.values()) {
        if (tab.userId !== userId) continue;
        for (const open of [...tab.open]) if (open.teamId === teamId) open.connection.close(FORBIDDEN);
      }
    },
    closeNote(noteId) {
      hocuspocus.closeConnections(noteId);
    },
  };

  return {
    hocuspocus,
    control,
    /**
     * Stop accepting sockets, drop the open ones, and wait until every pending edit is saved.
     * Rejects if any save failed. Safe to call more than once.
     */
    close(): Promise<void> {
      return (closing ??= shutDown());
    },
  };
}

export type Realtime = ReturnType<typeof attachRealtime>;
