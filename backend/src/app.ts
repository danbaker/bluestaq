import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import type { Db } from "./db/client.js";
import { createRepositories, type Repositories } from "./repositories/index.js";
import { createAuthRouter } from "./auth/routes.js";
import { requireAuth } from "./auth/middleware.js";
import { createTeamRouter } from "./teams/routes.js";
import { createUserRouter } from "./users/routes.js";
import { createNoteRouter, createTeamNotesRouter } from "./notes/routes.js";
import { requireTeamMember } from "./teams/middleware.js";

export interface AppOptions {
  db: Db;
  jwtSecret: string;
  secureCookie?: boolean;
  /** Share repositories with other layers (e.g. realtime). Built from db if omitted. */
  repos?: Repositories;
}

export function createApp({ db, jwtSecret, secureCookie = false, repos = createRepositories(db) }: AppOptions) {
  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json());
  app.use(cookieParser());

  const { users, teams, notes } = repos;
  const auth = requireAuth(jwtSecret);

  // Public
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.use("/api/auth", createAuthRouter({ users, jwtSecret, secureCookie }));

  // Protected
  app.get("/api/hello", requireAuth(jwtSecret), (req, res) => {
    const name = typeof req.query.name === "string" && req.query.name ? req.query.name : req.session!.username;
    res.json({ message: `Hello, ${name}!` });
  });

  app.use("/api/users", auth, createUserRouter({ users }));
  app.use("/api/teams/:id/notes", auth, requireTeamMember(teams), createTeamNotesRouter({ notes }));
  app.use("/api/teams", auth, createTeamRouter({ teams, users }));
  app.use("/api/notes", auth, createNoteRouter({ notes, teams }));

  // API errors are always JSON, never an HTML page or a stack trace.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  const onError: ErrorRequestHandler = (err, _req, res, next) => {
    if (res.headersSent) return next(err);
    if (err?.type === "entity.parse.failed") {
      res.status(400).json({ error: "Invalid JSON" });
      return;
    }
    if (err?.type === "entity.too.large") {
      res.status(413).json({ error: "Request body too large" });
      return;
    }
    const status = Number(err?.status ?? err?.statusCode);
    if (status >= 400 && status < 500) {
      // Other client errors (e.g. 415 unsupported charset). Their message is written for clients; use it when exposed.
      res.status(status).json({ error: err.expose && typeof err.message === "string" ? err.message : "Bad request" });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  };
  app.use(onError);

  return app;
}
