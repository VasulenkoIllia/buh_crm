import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * **A PATCH that leaves a field out must not change it.** In zod 4 `.partial()` keeps a field's
 * `.default()`, so an update schema built from a create schema reads an omitted field as if the
 * request had sent the default, and the service writes it. Five schemas had it: clients and tasks
 * long ago, then on 2026-11-22 a template's kind (switched off and on, a transactional letter turned
 * commercial), a meeting's participants (Cancel emptied the meeting) and a task template's
 * `billable` (every edit set it back to true). Each was fixed by hand, and only a comment stood
 * against a sixth.
 *
 * So every exported `update*Input` in this folder is collected by walking the modules, and a new
 * one is covered the day it is written: its fields must read `{}` as exactly `{}`. What it does not
 * see: a PATCH body named otherwise, and defaults inside a nested object, which a request that sends
 * one replaces whole.
 */
const modules = import.meta.glob<Record<string, unknown>>(
  ["./*.ts", "!./*.test.ts", "!./index.ts"], // index.ts only re-exports what the walk already sees
  { eager: true },
);

/**
 * Update schemas that replace the whole record, so `{}` is meant to fail on their required fields.
 * An entry here must still refuse `{}` (checked below), or it would hide a schema that now should
 * be covered.
 */
const FULL_REPLACES: Record<string, string> = {
  updateCampaignInput: "is campaignInput itself: a scheduled campaign is saved whole",
  updateLeadStageInput: "is a rename, and the name is the whole edit",
};

const updateSchemas = Object.entries(modules).flatMap(([file, exports]) =>
  Object.entries(exports)
    .filter(([name, value]) => /^update\w*Input$/.test(name) && value instanceof z.ZodType)
    .map(([name, value]) => ({ file, name, schema: value as z.ZodType })),
);

/**
 * The fields alone, without the object's own refinements. Some update schemas refuse `{}` on
 * purpose ("Nothing to change"), and that refusal would hide a default on any field it does not
 * name. A schema that is not a plain object (a transform, say) is read whole.
 */
const fieldsOf = (schema: z.ZodType): z.ZodType =>
  schema instanceof z.ZodObject ? z.object(schema.shape) : schema;

/** What `{}` turns into, or why it fails: `null` when it stays exactly `{}`. */
function readOfEmpty(schema: z.ZodType): string | null {
  const parsed = schema.safeParse({});
  if (!parsed.success) {
    return `refuses {}: ${parsed.error.issues.map((i) => i.path.join(".") || i.message).join(", ")}`;
  }
  return Object.keys(parsed.data as object).length === 0
    ? null
    : `reads {} as ${JSON.stringify(parsed.data)}`;
}

describe("an update schema reads a field it is not sent as untouched", () => {
  it("finds the five that have bitten, so a passing test cannot mean the walk broke", () => {
    const names = updateSchemas.map((s) => s.name);
    for (const name of [
      "updateClientInput",
      "updateTaskInput",
      "updateTemplateInput",
      "updateMeetingInput",
      "updateTaskTemplateInput",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("gives back exactly {} for {}, field by field and whole", () => {
    const wrong = updateSchemas
      .filter((s) => !(s.name in FULL_REPLACES))
      .flatMap(({ file, name, schema }) => {
        const fields = readOfEmpty(fieldsOf(schema));
        if (fields) return [`${name} (${file}) ${fields}`];
        // the whole object may still add a key the fields do not, through an object-level .overwrite()
        const whole = schema.safeParse({});
        return whole.success && Object.keys(whole.data as object).length > 0
          ? [`${name} (${file}) reads {} as ${JSON.stringify(whole.data)}`]
          : [];
      });
    expect(
      wrong,
      wrong.length === 0
        ? ""
        : `\n\n  ${wrong.join("\n  ")}\n\n` +
            `  A PATCH names only what it changes. zod 4's .partial() keeps a field's .default(),\n` +
            `  so a request that leaves the field out is read as if it sent the default, and the\n` +
            `  service writes it. Override the field after .partial() with no default, as\n` +
            `  updateTaskTemplateInput does: .extend({ billable: z.boolean().optional() }).\n` +
            `  If the schema really replaces the whole record, name it in FULL_REPLACES with why.\n`,
    ).toEqual([]);
  });

  it("names in FULL_REPLACES only schemas that exist and still refuse {}", () => {
    for (const name of Object.keys(FULL_REPLACES)) {
      const found = updateSchemas.find((s) => s.name === name);
      expect(found, `${name} is in FULL_REPLACES but no module exports it`).toBeDefined();
      // the fields, as above: a refine that refuses {} must not keep a defaulted schema listed here
      expect(
        found && fieldsOf(found.schema).safeParse({}).success,
        `${name} now accepts {}: take it off FULL_REPLACES so the check above covers it`,
      ).toBe(false);
    }
  });
});
