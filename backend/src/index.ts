import "dotenv/config"; // must be first: config.ts reads env at import time
import { config } from "./config.js";
import { initDatabase } from "./db/index.js";
import { createServer } from "./server.js";

const db = await initDatabase();
const { server } = createServer({
  db,
  jwtSecret: config.jwtSecret,
  secureCookie: config.isProduction,
  clientOrigin: config.clientOrigin,
});
server.listen(config.port, () => {
  console.log(`Backend listening on http://localhost:${config.port} (WebSocket at /ws)`);
});
