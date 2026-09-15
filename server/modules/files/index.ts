import type { FastifyInstance } from "fastify";
import { registerRoutes } from "./files.routes.js";

// For the client card's Upload, which puts a new document into the client's Internal through the
// same door the Files screen uses (files.md §4.2), and for the cards' upload routes' own limit.
export { uploadToClientCard } from "./files.service.js";
export { UPLOAD_RATE_LIMIT } from "./files.routes.js";
// the cards' delete and Undo (files.md §9), and the nightly purge `server.ts` schedules
export { purgeTrash, trashCardFile, undoCardTrash } from "./files.trash.js";

export async function filesModule(app: FastifyInstance) {
  await registerRoutes(app);
}
