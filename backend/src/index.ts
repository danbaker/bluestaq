import "dotenv/config"; // must be first: config.ts reads env at import time
import { config } from "./config.js";
import { initDatabase } from "./db/index.js";
import { createServer } from "./server.js";

const db = await initDatabase();
const { server, realtime } = createServer({
  db,
  jwtSecret: config.jwtSecret,
  secureCookie: config.isProduction,
  clientOrigin: config.clientOrigin,
});
server.listen(config.port, () => {
  console.log(`Backend listening on http://localhost:${config.port} (WebSocket at /ws)`);
});

// On shutdown (including dev-server reloads): stop taking new requests, save every note being
// edited, then close the database. Exit non-zero if any save failed.
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: saving open notes and shutting down`);
  setTimeout(() => process.exit(1), 10_000).unref(); // never hang forever
  let code = 0;
  server.close(); // stop accepting connections
  server.closeIdleConnections();
  try {
    await realtime.close();
  } catch (err) {
    console.error("Some notes could not be saved", err);
    code = 1;
  }
  try {
    await db.end();
  } catch (err) {
    console.error("Closing the database failed", err);
    code = 1;
  }
  process.exit(code);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
