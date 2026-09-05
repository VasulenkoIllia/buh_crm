import {
  NOTIFICATION_TRIGGER_KEYS,
  type NotificationTriggerKey,
} from "@shared/notifications.js";
import type { SetPreferenceInput, UpdatePolicyInput } from "@shared/schema/notification.js";
import { NotFoundError } from "../../core/errors.js";
import * as repo from "./notifications.repository.js";

/**
 * Twenty at a time — a PAGE now, not a ceiling.
 *
 * It was a hard cap, and §6.1 chose that deliberately: no paging, no history screen, anything
 * older found through the task it was about. The first real production forecast broke it on day
 * one (2026-09-06): one admin would have woken to 24 unread, of which the tray could render 20
 * and NO screen could reach the other four. A badge that counts rows a person cannot open is a
 * badge that teaches them to ignore it.
 *
 * "Show more" is the smallest fix that keeps the original decision intact — still the tray, still
 * unread only, still newest first, and still no second screen. `LIMIT n ORDER BY createdAt DESC`
 * on `(userId, readAt)` stays an index walk at every page (measured at 120 000 rows), and the cap
 * keeps a hand-written `?limit=` from asking for the table.
 */
const TRAY_PAGE = 20;
const TRAY_MAX = 100;

export async function tray(userId: string, limit = TRAY_PAGE) {
  const take = Math.min(Math.max(limit, 1), TRAY_MAX);
  const [items, unread] = await Promise.all([
    repo.listUnread(userId, take),
    repo.countUnread(userId),
  ]);
  return {
    unread,
    items: items.map((n) => ({
      id: n.id,
      trigger: n.trigger,
      text: n.text,
      sub: n.sub,
      linkType: n.linkType,
      linkId: n.linkId,
      // decided when the row was written, so the browser is not a second place the rule lives
      sound: n.sound,
      readAt: n.readAt?.toISOString() ?? null,
      createdAt: n.createdAt.toISOString(),
    })),
  };
}

/**
 * `Open` and `Dismiss` do the same thing to the row — the prototype REMOVES a dismissed row and we
 * stamp it read instead. The gesture feels identical, nothing is destroyed, and it gives the
 * retention purge something to count from (§6.1).
 */
export async function dismiss(userId: string, id: string) {
  const { count } = await repo.markRead(userId, id);
  if (count > 0) return { ok: true as const };

  /**
   * A zero means one of two very different things, and they must not share an answer: the row was
   * ALREADY read (two tabs, a double click — not an error), or it is not this person's row at all.
   * `markRead` is scoped by userId and so cannot tell them apart on its own; asking whether the
   * row exists FOR THIS USER can.
   */
  const own = await repo.findOwn(userId, id);
  if (!own) throw new NotFoundError("Notification not found");
  return { ok: true as const };
}

export async function dismissAll(userId: string) {
  const { count } = await repo.markAllRead(userId);
  return { ok: true as const, count };
}

// ── the personal contour ─────────────────────────────────────────────────────

/**
 * The profile screen's one read: the registry (what exists), the policy (what is allowed and what
 * the default is) and this person's own rows (what they chose).
 *
 * The registry is sent as well as read by the browser so the two halves cannot disagree about
 * which trigger a row belongs to — but it is the CONSTANT the screen renders from, not this.
 */
export async function myPreferences(userId: string) {
  const [policies, prefs] = await Promise.all([
    repo.listPolicies(),
    repo.listPreferences(userId),
  ]);
  const byTrigger = new Map(policies.map((p) => [p.trigger, p]));

  return {
    triggers: NOTIFICATION_TRIGGER_KEYS.filter((t) => byTrigger.has(t)).map((trigger) => {
      const policy = byTrigger.get(trigger)!;
      return {
        trigger,
        enabled: policy.enabled,
        mandatory: policy.mandatory,
        allowedInApp: policy.inApp,
        allowedEmail: policy.email,
        allowedSound: policy.sound,
        defaultInApp: policy.defaultInApp,
        defaultEmail: policy.defaultEmail,
        defaultSound: policy.defaultSound,
        // null = follow the default. The absence of a row IS the answer (§4.3).
        inApp:
          prefs.find((p) => p.trigger === trigger && p.channel === "in_app")?.enabled ?? null,
        email:
          prefs.find((p) => p.trigger === trigger && p.channel === "email")?.enabled ?? null,
        sound:
          prefs.find((p) => p.trigger === trigger && p.channel === "sound")?.enabled ?? null,
      };
    }),
  };
}

export async function setMyPreferences(userId: string, input: SetPreferenceInput) {
  const known = new Set((await repo.listPolicies()).map((p) => p.trigger));
  for (const change of input.changes) {
    if (!known.has(change.trigger)) throw new NotFoundError("Unknown notification trigger");
  }

  // Applied in order and one at a time: they are independent single-row writes, and a transaction
  // would buy nothing except a lock held across the whole group toggle.
  for (const change of input.changes) {
    if (change.enabled === null) {
      // "follow the default" is the ABSENCE of a row, never a third stored value (§4.3)
      await repo.clearPreference(userId, change.trigger, change.channel);
    } else {
      await repo.setPreference(userId, change.trigger, change.channel, change.enabled);
    }
  }
  return myPreferences(userId);
}

// ── the global contour (admin) ───────────────────────────────────────────────

/**
 * The policy screen's read. Every field the screen shows comes from the REGISTRY except the four
 * the firm can change, which is what makes the screen unable to list a trigger that does not fire.
 */
export async function policies() {
  const rows = await repo.listPolicies();
  const byTrigger = new Map(rows.map((p) => [p.trigger, p]));
  return {
    triggers: NOTIFICATION_TRIGGER_KEYS.filter((t) => byTrigger.has(t)).map((trigger) => {
      const p = byTrigger.get(trigger)!;
      return {
        trigger,
        enabled: p.enabled,
        mandatory: p.mandatory,
        roles: p.roles,
        inApp: p.inApp,
        email: p.email,
        sound: p.sound,
        defaultInApp: p.defaultInApp,
        defaultEmail: p.defaultEmail,
        defaultSound: p.defaultSound,
      };
    }),
  };
}

export async function updatePolicy(trigger: string, input: UpdatePolicyInput) {
  if (!NOTIFICATION_TRIGGER_KEYS.includes(trigger as NotificationTriggerKey)) {
    throw new NotFoundError("Unknown notification trigger");
  }
  const existing = await repo.findPolicy(trigger);
  if (!existing) throw new NotFoundError("Unknown notification trigger");

  await repo.updatePolicy(trigger, input);
  return policies();
}
