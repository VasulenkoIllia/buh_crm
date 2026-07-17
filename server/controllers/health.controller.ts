import type { IncomingMessage, ServerResponse } from "node:http";

export function healthController(_req: IncomingMessage, res: ServerResponse) {
  const appName = process.env.APP_NAME || "app";

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      status: "ok",
      app: appName,
      timestamp: new Date().toISOString()
    })
  );
}
