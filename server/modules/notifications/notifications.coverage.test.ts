/**
 * **A module cannot ship without somebody deciding whether it needs notifications.**
 *
 * The question was being asked by accident or not at all: two modules landed while the registry
 * existed and neither was ever weighed against it. This is what turns "remember to ask" into
 * "cannot ship without answering", and it is written as a test rather than a rule in a document
 * for a reason that is easy to check — `AGENTS.md`, `CLAUDE.md` and all of `docs/` are gitignored.
 * A fresh clone of this repository gets 313 code files and three markdown files, none of which is
 * the operating standard. The only rules that travel with the code are the ones the code enforces.
 *
 * Which makes the FAILURE MESSAGE the real documentation here: it is the one place this rule
 * reaches somebody who has read nothing. It has to teach, not merely fail.
 */
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MODULE_NOTIFICATIONS,
  NOTIFICATION_TRIGGER_KEYS,
  type NotificationTriggerKey,
} from "@shared/notifications.js";

const onDisk = readdirSync("server/modules", { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

describe("every module has answered the notification question", () => {
  it("finds the modules at all, so a passing test cannot mean the read broke", () => {
    expect(onDisk.length).toBeGreaterThan(5);
  });

  it("has an entry for every module on disk", () => {
    const undecided = onDisk.filter((m) => !(m in MODULE_NOTIFICATIONS));
    expect(
      undecided,
      undecided.length === 0
        ? ""
        : `\n\n  ${undecided.join(", ")} — no notification decision recorded.\n\n` +
            `  Adding a module means deciding whether anything in it is worth telling somebody\n` +
            `  about. Both answers are fine; neither may be left implicit, because an absent\n` +
            `  trigger and a forgotten one look identical afterwards.\n\n` +
            `  Open shared/notifications.ts -> MODULE_NOTIFICATIONS and add EITHER:\n` +
            `    ${undecided[0]}: ["your_trigger_key"],        // and register the trigger above\n` +
            `  OR the sentence that says why it stays quiet:\n` +
            `    ${undecided[0]}: "Editing one of these is a step of ordinary work, not news.",\n\n` +
            `  The rule that decides it (docs/modules/notifications.md §3.2): a lifecycle event of a\n` +
            `  record — created, assigned, completed, cancelled, overdue — is worth a notification.\n` +
            `  A step of ordinary work is not: it fires dozens of times a day and IS the work.\n`,
    ).toEqual([]);
  });

  it("names no module that is not there, so a deleted one cannot leave a stale entry", () => {
    const ghosts = Object.keys(MODULE_NOTIFICATIONS).filter((m) => !onDisk.includes(m));
    expect(ghosts).toEqual([]);
  });

  it("accounts for every trigger exactly once", () => {
    const claimed = Object.values(MODULE_NOTIFICATIONS)
      .filter((v): v is readonly NotificationTriggerKey[] => Array.isArray(v))
      .flat();

    // a trigger nobody claims is one nobody owns — the first question after "it fired, and?"
    expect(NOTIFICATION_TRIGGER_KEYS.filter((k) => !claimed.includes(k))).toEqual([]);
    // and two owners is worse than none: it makes "who decided this" unanswerable
    expect(claimed.filter((k, i) => claimed.indexOf(k) !== i)).toEqual([]);
    // no invented keys
    expect(claimed.filter((k) => !NOTIFICATION_TRIGGER_KEYS.includes(k))).toEqual([]);
  });

  it("gives a real reason for silence, not a shrug", () => {
    for (const [module, value] of Object.entries(MODULE_NOTIFICATIONS)) {
      if (Array.isArray(value)) continue;
      // "N/A" or "none" records nothing and defends nothing; the next person re-opens the question
      expect(String(value).length, module).toBeGreaterThan(40);
    }
  });
});
