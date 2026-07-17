import type { IncomingMessage, ServerResponse } from "node:http";
import { healthController } from "../controllers/health.controller.js";

export function handleRoutes(req: IncomingMessage, res: ServerResponse) {
  if (req.url === "/health") {
    healthController(req, res);
    return true;
  }

  return false;
}
