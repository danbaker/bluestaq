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

  // Malformed JSON -> 400; anything unexpected -> 500 JSON (never a stack trace).
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err?.type === "entity.parse.failed") {
      res.status(400).json({ error: "Invalid JSON" });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  };
  app.use(onError);

  return app;
}
