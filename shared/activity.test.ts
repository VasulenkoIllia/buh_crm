import { isGateKey } from "./access.js";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_EVENTS,
  ACTIVITY_KEYS,
  PLANNED_EVENT_KEYS,
  SUBJECT_GATE,
  SUBJECT_GROUP,
  TIER1_REFUSED,
  TIER1_REQUEST,
  groupOf,
  isActivityKey,
  renderTitle,
  retentionYears,
  type ActivitySubject,
} from "./activity.js";

/**
 * **The registry's own rules, held mechanically.**
 *
 * At this size an inconsistent vocabulary is what makes a registry unusable (activity-log.md §4.1),
 * and "somebody will notice in review" is not a mechanism. These are the invariants a person would
 * otherwise have to hold in their head while typing the hundred-and-thirty-ninth entry.
 */

const KEY_SHAPE = /^[a-z_]+\.[a-z_]+$/;
const SUBJECTS = new Set(Object.keys(SUBJECT_GROUP));

describe("the activity registry", () => {
  it("names every event <subject>.<verb_past>, with the subject it declares", () => {
    const wrong: string[] = [];
    for (const key of ACTIVITY_KEYS) {
      if (!KEY_SHAPE.test(key)) wrong.push(`${key}: not <subject>.<verb>`);
      const prefix = key.split(".")[0];
      if (prefix !== ACTIVITY_EVENTS[key].subject) {
        wrong.push(`${key}: declares subject "${ACTIVITY_EVENTS[key].subject}"`);
      }
    }
    /**
     * The rule exists so a key can be GUESSED. A reader who knows the subject and the verb should
     * not have to open this file to find out whether it is `client.updated` or `clients.edited`.
     */
    expect(wrong).toEqual([]);
  });

  /**
   * Every subject must name a gate, or the reader-side filter silently drops its events — which
   * would be the log quietly hiding things rather than quietly leaking them. Both failures are
   * invisible, which is why this is mechanical.
   */
  it("files every subject under a gate as well as a group", () => {
    for (const key of ACTIVITY_KEYS) {
      const subject = ACTIVITY_EVENTS[key].subject;
      expect(SUBJECT_GATE[subject], `${subject} names no gate`).toBeTruthy();
    }
    expect(Object.keys(SUBJECT_GATE).sort()).toEqual(Object.keys(SUBJECT_GROUP).sort());
    /**
     * And the gate NAMES must be real. A typo, or a gate renamed in `shared/access.ts`, would make
     * `visibleSubjects()` treat that subject as gate-less and hide it from everyone — it fails
     * safe, which is exactly why nobody would notice.
     */
    const unknown = Object.entries(SUBJECT_GATE).filter(([, gate]) => !isGateKey(gate));
    expect(unknown, "a subject names a gate that does not exist").toEqual([]);
  });

  it("files every subject in exactly one group", () => {
    for (const key of ACTIVITY_KEYS) {
      expect(SUBJECT_GROUP[ACTIVITY_EVENTS[key].subject], `${key} has no group`).toBeTruthy();
      expect(groupOf(key)).toBe(SUBJECT_GROUP[ACTIVITY_EVENTS[key].subject]);
    }
  });

  /**
   * The planned keys are the pass's checklist (§4.5's "all of them in one pass"): each moves into the
   * registry when its service is opened and its diff keys stop being a guess. A key in both lists,
   * or in neither, is how that checklist would quietly stop being one.
   */
  it("keeps the declared and the planned lists disjoint, and both well-formed", () => {
    const declared = new Set<string>(ACTIVITY_KEYS);
    const overlap = PLANNED_EVENT_KEYS.filter((k) => declared.has(k));
    expect(
      overlap,
      "a planned key is already declared — delete it from PLANNED_EVENT_KEYS",
    ).toEqual([]);

    const malformed = PLANNED_EVENT_KEYS.filter(
      (k) => !KEY_SHAPE.test(k) || !SUBJECTS.has(k.split(".")[0] as ActivitySubject),
    );
    expect(malformed, "a planned key names a subject that does not exist").toEqual([]);

    expect(new Set(PLANNED_EVENT_KEYS).size, "a planned key is listed twice").toBe(
      PLANNED_EVENT_KEYS.length,
    );
  });

  /**
   * **The one place the count is written down, and it is an assertion rather than a sentence.**
   *
   * The drafts carried it in prose in seven places at once — §4.4's column header, its own column
   * sum, the registry's docblock, this test's TITLE — and they disagreed with each other and with
   * the registry: 138, 139, 137, 136, while the real number grew past all four. Every one of them
   * had to be believed by a reader who could not check it. So they are gone, and this line is what
   * is left: a key added or removed without somebody meaning it fails here (audit, 2026-09-09).
   */
  it("holds the measured inventory, with every key declared", () => {
    // grown three times since the first pass: `settings.activity_switched` (the switch that decides
    // what the log holds was the one firm setting nothing recorded); the twelve the Leads module
    // needed — the one part of the product that changed things and recorded none; and the seven a
    // run of the whole suite found leaving only bare rows — the timer's start and stop, a job's
    // checklist, a client's own unsubscribe, a priority's rename and its order, the catalog's
    // order (2026-09-10); and the seven of two-factor sign-in — on, off, an admin's reset, new
    // recovery codes, a recovery code used, a failed second factor, the firm's rule (2026-09-12)
    expect(ACTIVITY_KEYS.length).toBe(163);
    // the checklist is empty because the pass is finished — not because it was abandoned
    expect(PLANNED_EVENT_KEYS).toEqual([]);
  });

  it("declares changeKeys as a real, unique list wherever it declares one", () => {
    for (const key of ACTIVITY_KEYS) {
      const spec = ACTIVITY_EVENTS[key];
      if (!spec.changeKeys) continue;
      expect(
        spec.changeKeys.length,
        `${key}: empty changeKeys — omit it instead`,
      ).toBeGreaterThan(0);
      expect(new Set(spec.changeKeys).size, `${key}: duplicate changeKey`).toBe(
        spec.changeKeys.length,
      );
    }
  });

  it("gives every event an actor kind and a real dedupe window", () => {
    for (const key of ACTIVITY_KEYS) {
      const spec = ACTIVITY_EVENTS[key];
      expect(spec.actorKinds.length, `${key}: no actorKinds`).toBeGreaterThan(0);
      if (spec.dedupe) expect(spec.dedupe.windowMinutes).toBeGreaterThan(0);
      expect(spec.title.length, `${key}: no title`).toBeGreaterThan(0);
      expect(spec.when.length, `${key}: no legend`).toBeGreaterThan(0);
    }
  });

  /**
   * §11's four classes, spot-checked at the boundary rather than restated: the ones a dispute or an
   * examination asks about are kept for seven years, everything else for two.
   */
  it("keeps sign-ins, role changes and access changes seven years, and ordinary events two", () => {
    expect(retentionYears("session.signed_in")).toBe(7);
    expect(retentionYears("session.sign_in_failed")).toBe(7);
    expect(retentionYears("user.role_changed")).toBe(7);
    expect(retentionYears("access.policy_changed")).toBe(7);
    expect(retentionYears("system.data_reset")).toBe(7);
    expect(retentionYears("client.updated")).toBe(2);
    expect(retentionYears("invoice.issued")).toBe(2);
  });

  /**
   * `client.viewed` is the one event that would let a breach be scoped precisely and the noisiest in
   * the product — every navigation. It ships present and off, and a firm with a reason to turn it on
   * can, without a deploy (§3.2). Nothing else ships off: an event the firm has never seen and
   * cannot know about is not one they decided to silence.
   */
  it("ships the client-card open present and off, and every other event on", () => {
    expect(ACTIVITY_EVENTS["client.viewed"].enabledByDefault).toBe(false);
    const off = ACTIVITY_KEYS.filter((k) => !ACTIVITY_EVENTS[k].enabledByDefault);
    expect(off).toEqual(["client.viewed"]);
  });

  /**
   * Two placeholders, each with one source. A `{count}` would have had to guess which key of
   * `changes` held the number, and a sentence that is right on some rows and wrong on others is
   * worse than one that carries no number at all.
   */
  it("uses only the placeholders the renderer can fill", () => {
    const stray: string[] = [];
    for (const key of ACTIVITY_KEYS) {
      for (const token of ACTIVITY_EVENTS[key].title.match(/\{[a-z]+\}/g) ?? []) {
        if (token !== "{actor}" && token !== "{subject}") stray.push(`${key}: ${token}`);
      }
    }
    expect(stray).toEqual([]);
    expect(
      renderTitle("client.created", { actorLabel: "Olena", subjectLabel: "Petrenko" }),
    ).toBe("Olena added the client Petrenko");
    // an event with no subject of its own still reads as a sentence
    expect(renderTitle("secret.vault_unlocked", { actorLabel: "Olena" })).toBe(
      "Olena unlocked the vault",
    );
  });

  /**
   * A handful of acts are about a client without naming a thing of their own — unsubscribing them
   * from mail, unlocking their vault. Those rendered "changed whether — receives mail" until the
   * renderer learned to reach for the client first.
   */
  it("names the client when the subject has no label of its own", () => {
    expect(
      renderTitle("client.mail_subscription_changed", {
        actorLabel: "Olena",
        subjectLabel: null,
        clientLabel: "Petrenko",
      }),
    ).toBe("Olena changed whether Petrenko receives mail");
    // and the subject still wins when there is one
    expect(
      renderTitle("company.deleted", {
        actorLabel: "Olena",
        subjectLabel: "Petrenko LLC",
        clientLabel: "Petrenko",
      }),
    ).toBe("Olena removed the company Petrenko LLC");
  });

  it("declares the two keys the tier-1 hook writes itself", () => {
    expect(isActivityKey(TIER1_REQUEST)).toBe(true);
    expect(isActivityKey(TIER1_REFUSED)).toBe(true);
    expect(isActivityKey("client.definitely_not_a_key")).toBe(false);
  });
});
