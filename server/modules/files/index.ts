import type { FastifyInstance } from "fastify";
import { registerRoutes } from "./files.routes.js";

// the cards' upload routes' own limit, the same as the library's (files.md §7.1)
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
// keeping a file that arrived somewhere else: a chat's, which the firm means to hold on to
// (chat.md §6.5). The library's gate is checked inside it, because the caller's route is not ours.
export { copyIntoLibrary } from "./files.service.js";
// the reader every module with places asks about the OTHER gate: the vault's client lists need
// Clients open as well as Secrets (secrets.md §4.3, §12), the way the library's do (files.md §11.3)
export { opens, readerOf, requireOpen, requireReadable, type Reader } from "./files.access.js";
// Settings → System → Storage (§4.4)
export { storageReport } from "./files.storage.js";
// what a file is, from its bytes, and how it leaves the server: the cards' routes send theirs
// through the same two doors as the library's (§12.2)
export { detectType, viewOf } from "./files.types.js";
export { NOT_VIEWABLE, sendDownload, sendPreview, sendView } from "./files.serve.js";
// stage C's one-off over the files stored before (`scripts/detect-file-types.ts`)
export { detectStoredTypes } from "./files.backfill.js";
// the check before and after a deploy that moves files (`scripts/check-files.ts`, §15.3)
export { checkFileBytes, filesReport } from "./files.check.js";

export async function filesModule(app: FastifyInstance) {
  await registerRoutes(app);
}
