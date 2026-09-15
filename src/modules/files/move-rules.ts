import {
  areaBase,
  clientSees,
  placeLabel,
  sameClient,
  samePlace,
  type UiPlace,
} from "./places";

/**
 * **What a move means, said before it happens** (files.md §6.2). The same words the Move dialog
 * shows and a drag onto the tree asks about: whether the client will start or stop seeing the
 * files, whether they leave a client or My files, and whether any leave their task. The server
 * holds every rule; this only tells the person which one they are about to meet.
 */

export interface MoveLine {
  tone: "info" | "warn";
  text: string;
}

export interface MoveCheck {
  /** false when this reader may not make the move at all */
  allowed: boolean;
  /** why not, for a disabled target */
  reason?: string;
  /** a route of its own for an admin's move out of a client (§11.1) */
  url: string;
  lines: MoveLine[];
}

export interface MoveFacts {
  from: UiPlace;
  to: UiPlace;
  /** files moving, counting inside folders */
  files: number;
  /** of those, the ones on a task */
  onTasks: number;
  admin: boolean;
  /** a client's name, for the sentences */
  clientName: (clientId: string) => string;
}

const them = (n: number) => (n === 1 ? "this file" : `these ${n} files`);

export function checkMove(f: MoveFacts): MoveCheck {
  const { from, to } = f;
  const leavesClient = from.kind === "client" && !sameClient(from, to);
  const url = `${areaBase(from)}/${leavesClient ? "move-out" : "move"}`;
  if (leavesClient && !f.admin) {
    return {
      allowed: false,
      reason: "Only an admin moves files out of a client",
      url,
      lines: [],
    };
  }

  const lines: MoveLine[] = [];
  const stillSeen = clientSees(from) && clientSees(to) && sameClient(from, to);
  if (clientSees(to) && !stillSeen && to.kind === "client") {
    lines.push({
      tone: "info",
      text: `${f.clientName(to.clientId)} will see ${them(f.files)} once the portal opens.`,
    });
  }
  if (clientSees(from) && !stillSeen && from.kind === "client") {
    lines.push({
      tone: "warn",
      text: `${f.clientName(from.clientId)} will no longer see ${them(f.files)}.`,
    });
  }
  if (from.kind === "my" && to.kind !== "my") {
    lines.push({
      tone: "info",
      text: `Out of My files: everyone who can see ${placeLabel(to, to.kind === "client" ? f.clientName(to.clientId) : undefined)} will see ${them(f.files)}.`,
    });
  }
  if (leavesClient && from.kind === "client") {
    lines.push({
      tone: "warn",
      text: `Out of ${f.clientName(from.clientId)}'s files. Only admins may do this, and the activity log keeps it.`,
    });
  }
  // a file on a task never leaves its task's place: the client's, or Company for an internal task
  const leavesTaskPlace = from.kind !== to.kind || leavesClient;
  if (f.onTasks > 0 && leavesTaskPlace && !samePlace(from, to)) {
    lines.push({
      tone: "warn",
      text:
        f.onTasks === 1
          ? "One of them is on a task, and will leave it."
          : `${f.onTasks} of them are on tasks, and will leave them.`,
    });
  }
  return { allowed: true, url, lines };
}
