/**
 * The registry is the source (§3). These tests hold the three things that can silently disagree
 * with it: the call sites, the seeded policy rows, and the spec's own tables.
 *
 * All three have drifted at least once. `ops_mailout_errors` reached nobody for a day because the
 * registry said `["author","custom"]` and the database said `["custom"]`; §3.2 said "16 triggers"
 * for two days after twenty existed. Types caught neither — both halves type-check perfectly while
 * disagreeing, which is precisely why they need a test rather than care.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_TRIGGERS,
  type NotificationTriggerKey,
} from "../../../shared/notifications.js";

const KEYS = Object.keys(NOTIFICATION_TRIGGERS) as NotificationTriggerKey[];

/** Every server source file, tests excluded — a `notify()` inside a test proves nothing is wired. */
function serverSources(dir = "server", acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) serverSources(path, acc);
    else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) acc.push(path);
  }
  return acc;
}

const SOURCE = serverSources()
  .filter((p) => !p.endsWith("core/notify.ts"))
  .map((p) => readFileSync(p, "utf8"))
  .join("\n");

describe("the registry and the code that reads it", () => {
  it("wires every declared trigger to at least one call site", () => {
    const unwired = KEYS.filter((key) => !SOURCE.includes(`notify("${key}"`));
    expect(unwired).toEqual([]);
  });

  it("emits no trigger that the registry does not declare", () => {
    const emitted = [...SOURCE.matchAll(/\bnotify\("([a-z_]+)"/g)].map((m) => m[1]);
    expect(
      [...new Set(emitted)].filter((k) => !KEYS.includes(k as NotificationTriggerKey)),
    ).toEqual([]);
  });
});

/**
 * `docs/` is gitignored and stays local, so this half runs for whoever has the spec and skips for
 * whoever does not. It is worth having anyway: the spec is what gets read before the code is, and
 * a spec that is confidently wrong costs more than one that is missing.
 */
describe.skipIf(!existsSync("docs/modules/notifications.md"))("the spec's tables", () => {
  const SPEC = existsSync("docs/modules/notifications.md")
    ? readFileSync("docs/modules/notifications.md", "utf8")
    : "";

  it("lists every trigger in §3.2, and claims the right count", () => {
    const table = SPEC.split("### 3.2")[1]?.split("### 3.3")[0] ?? "";
    expect(KEYS.filter((key) => !table.includes(`\`${key}\``))).toEqual([]);
    expect(table).toContain(`The ${KEYS.length} triggers`);
  });

  it("names every trigger in the call-site table of §3.3", () => {
    const table = SPEC.split("### 3.3")[1]?.split("### 3.4")[0] ?? "";
    expect(KEYS.filter((key) => !table.includes(`\`${key}\``))).toEqual([]);
  });
});
