import "dotenv/config"; // must be first: config.ts reads env at import time
import { config } from "./config.js";
import { initDatabase } from "./db/index.js";
import { createApp } from "./app.js";

const db = await initDatabase();
createApp({ db, jwtSecret: config.jwtSecret, secureCookie: config.isProduction }).listen(config.port, () => {
  console.log(`Backend listening on http://localhost:${config.port}`);
});
