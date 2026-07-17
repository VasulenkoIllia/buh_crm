import http from "node:http";
import { handleRoutes } from "./routes/index.js";

export function createApp() {
  return http.createServer((req, res) => {
    const handled = handleRoutes(req, res);

    if (handled) {
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  });
}
