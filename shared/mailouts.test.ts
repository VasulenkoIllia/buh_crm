import { describe, expect, it } from "vitest";
import { renderMailText, sampleVars, usedVariables } from "./mailouts.js";

describe("renderMailText", () => {
  it("substitutes known variables", () => {
    const r = renderMailText("Hello {{first_name}}, your {{company}} return is ready.", {
      first_name: "Olena",
      company: "Kvitka Trade LLC",
    });
    expect(r.text).toBe("Hello Olena, your Kvitka Trade LLC return is ready.");
    expect(r.missing).toEqual([]);
    expect(r.unknown).toEqual([]);
  });

  it("tolerates spaces inside the braces, because people type them", () => {
    expect(renderMailText("Hi {{ first_name }}", { first_name: "Olena" }).text).toBe("Hi Olena");
  });

  /**
   * The rule the whole send path rests on: a required variable with no value is REPORTED. The
   * service turns this into a skipped recipient with a reason, so nobody is ever posted a letter
   * reading "Hello ,".
   */
  it("reports a required variable the recipient has no value for", () => {
    for (const empty of [null, undefined, "", "   "]) {
      const r = renderMailText("Hello {{first_name}},", { first_name: empty });
      expect(r.missing, `for ${JSON.stringify(empty)}`).toEqual(["first_name"]);
    }
  });

  it("does not report firm-level variables as missing — their absence is a settings gap", () => {
    const r = renderMailText("From {{firm_name}} — {{first_name}}", {
      firm_name: null,
      first_name: "Olena",
    });
    expect(r.missing).toEqual([]);
    expect(r.text).toBe("From  — Olena");
  });

  /** Deleting a typo would hide it until a client saw the hole. Leave it standing. */
  it("leaves an unknown variable visible and names it", () => {
    const r = renderMailText("Due {{deadline_date}} for {{first_name}}", { first_name: "Olena" });
    expect(r.text).toBe("Due {{deadline_date}} for Olena");
    expect(r.unknown).toEqual(["deadline_date"]);
  });

  it("reports each missing variable once however often it appears", () => {
    const r = renderMailText("{{company}} — {{company}} — {{company}}", { company: "" });
    expect(r.missing).toEqual(["company"]);
  });

  it("leaves text with no variables untouched", () => {
    const t = "A plain letter. Braces { } and {single} survive.";
    expect(renderMailText(t, {}).text).toBe(t);
  });

  it("does not re-scan substituted values — a name containing braces cannot inject a variable", () => {
    const r = renderMailText("Hi {{first_name}}", { first_name: "{{company}}", company: "ACME" });
    expect(r.text).toBe("Hi {{company}}");
  });
});

describe("usedVariables", () => {
  it("lists what a letter references, in catalog order, across subject and body", () => {
    expect(usedVariables("{{company}} update", "Dear {{first_name}}, ref {{company}}")).toEqual([
      "first_name",
      "company",
    ]);
  });

  it("ignores unknown names", () => {
    expect(usedVariables("{{nope}}")).toEqual([]);
  });
});

describe("sampleVars", () => {
  it("fills every catalog variable, so the editor preview never shows a hole", () => {
    const r = renderMailText(
      "{{first_name}} {{last_name}} {{full_name}} {{company}} {{email}} {{phone}} {{address}} " +
        "{{firm_name}} {{firm_email}}",
      sampleVars(),
    );
    expect(r.missing).toEqual([]);
    expect(r.text).not.toContain("{{");
  });
});
