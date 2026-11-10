import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import type { Db } from "./db/client.js";
import { createUserRepository } from "./repositories/userRepository.js";
import { createAuthRouter } from "./auth/routes.js";
import { requireAuth } from "./auth/middleware.js";

export interface AppOptions {
  db: Db;
  jwtSecret: string;
  secureCookie?: boolean;
}

export function createApp({ db, jwtSecret, secureCookie = false }: AppOptions) {
  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json());
  app.use(cookieParser());

  const users = createUserRepository(db);

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

  return app;
}
