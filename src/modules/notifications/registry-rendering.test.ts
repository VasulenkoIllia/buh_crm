import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { NOTIFICATION_TRIGGER_KEYS } from "@shared/notifications";

/**
 * Both settings screens must render from the REGISTRY, not from a list of their own.
 *
 * That is the whole reason `shared/notifications.ts` is a zero-dependency constant read by the UI:
 * a trigger cannot then exist on a screen and not in the code, or fire without appearing on the
 * screen. A hand-written list would drift the first time somebody added a trigger — silently, and
 * in the direction that looks fine.
 *
 * Asserted as SOURCE TEXT because there is no jsdom or testing-library in this project
 * (`vitest.config.ts`, `package.json`), so the screens cannot be rendered. It is the same
 * technique `src/app/code-splitting.test.ts` uses, and it catches the failure that matters: a
 * literal list of trigger keys appearing in a screen file.
 */
const SCREENS = ["notification-preferences.tsx", "notification-policy.tsx"] as const;

describe("the settings screens render from the trigger registry", () => {
  for (const screen of SCREENS) {
    it(`${screen} reads NOTIFICATION_TRIGGERS rather than listing them`, async () => {
      const source = await readFile(new URL(screen, import.meta.url), "utf8");

      expect(source, "the screen must take its triggers from the registry constant").toContain(
        "NOTIFICATION_TRIGGERS",
      );
      expect(source, "and its groups from the registry too").toContain("NOTIFICATION_GROUPS");

      /**
       * A screen that hardcodes even one key has started a second list, and two lists drift.
       *
       * Comments are stripped first: prose is allowed to NAME a trigger — the policy screen's own
       * comment explains why `invoice_overdue` will be the first reason to grow the screen — and a
       * test that forbade that would only teach people to write vaguer comments.
       */
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const hardcoded = NOTIFICATION_TRIGGER_KEYS.filter((key) =>
        new RegExp(`["'\`]${key}["'\`]`).test(code),
      );
      expect(
        hardcoded,
        `${screen} names trigger keys as literals (${hardcoded.join(", ")}). Render from ` +
          `NOTIFICATION_TRIGGERS instead — a second list is a list that drifts.`,
      ).toEqual([]);
    });
  }
});
