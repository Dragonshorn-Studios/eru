import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { createApp } from "./server.js";
import { createOpenCodeServer } from "./askserver.js";

const config = loadConfig();
const db = openDb(config.sqlitePath);
const openCodeServe = createOpenCodeServer({
  bin: config.openCodeBin,
  log: (msg) => console.log(`ask: ${msg}`),
});
const app = createApp({ config, db, openCodeServe });

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`Eru listening on http://${info.address}:${info.port}`);
});

function shutdown(signal: string) {
  console.log(`Received ${signal}, exiting`);
  openCodeServe.stop();
  db.close();
  server.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
