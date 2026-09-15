import type { FastifyInstance } from "fastify";
import { registerRoutes } from "./files.routes.js";

// For the client card's Upload, which puts a new document into the client's Internal through the
// same door the Files screen uses (files.md §4.2), and for the cards' upload routes' own limit.
export { uploadToClientCard } from "./files.service.js";
export { UPLOAD_RATE_LIMIT } from "./files.routes.js";
// the cards' delete and Undo (files.md §9), and the nightly purge `server.ts` schedules
export { purgeTrash, trashCardFile, undoCardTrash } from "./files.trash.js";
// the system's own moves (§8.3, §5.6): blocking moves a person's My files into Company,
// converting a lead files its tasks' files, and a converted lead's task goes on filing them
export {
  fileLeadFiles,
  movePersonalIntoCompany,
  personalFilesSummary,
  placeForConvertedLead,
  recordFiled,
  recordPersonalMove,
} from "./files.handover.js";
// every upload's name is cleaned and checked the same way, the task card's included (§14.3)
export { refuseProgram, uploadedFileName } from "./files.names.js";
export { asNameConflict } from "./files.service.js";
// Settings → System → Storage (§4.4)
export { storageReport } from "./files.storage.js";

export async function filesModule(app: FastifyInstance) {
  await registerRoutes(app);
}
