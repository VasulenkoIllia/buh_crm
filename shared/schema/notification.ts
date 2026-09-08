import { z } from "zod";
import { uuid } from "./common.js";
import { notificationChannel } from "./enums.js";
import { NOTIFICATION_TRIGGER_KEYS } from "../notifications.js";

/**
 * The trigger key, validated against the REGISTRY rather than a second list of sixteen strings.
 * `shared/notifications.ts` is zero-dependency and the UI reads it; this file already pulls zod,
 * so the dependency only ever points this way.
 */
export const notificationTrigger = z.enum(NOTIFICATION_TRIGGER_KEYS as [string, ...string[]]);

/** One row in the bell tray. */
export const notificationSchema = z.object({
  id: uuid,
  trigger: notificationTrigger,
  text: z.string(),
  sub: z.string().nullable(),
  linkType: z.string().nullable(),
  linkId: uuid.nullable(),
  /** whether this row was meant to chime — decided when it was written, not when it is read */
  sound: z.boolean(),
  readAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type Notification = z.infer<typeof notificationSchema>;

/**
 * The tray's one read. `unread` is the badge and is counted across ALL unread rows, not just the
 * twenty the tray renders — a badge that stopped at 20 would be a lie about how much is waiting.
 */
export const notificationTraySchema = z.object({
  unread: z.number().int(),
  items: z.array(notificationSchema),
});
export type NotificationTray = z.infer<typeof notificationTraySchema>;

/**
 * A personal choice. `enabled: null` DELETES the row — "follow the policy default" is the absence
 * of a preference, not a third stored value (see docs/modules/notifications.md §4.3).
 */
export const preferenceChange = z.object({
  trigger: notificationTrigger,
  channel: notificationChannel,
  enabled: z.boolean().nullable(),
});
export type PreferenceChange = z.infer<typeof preferenceChange>;

/**
 * Always a LIST, even for one switch.
 *
 * The group toggle on the profile screen sets both channels of every trigger in a group — up to
 * sixteen rows. As sixteen requests those race each other for the same read-modify-write and
 * arrive back out of order, so the screen would settle on whichever response was last rather than
 * on what the person asked for. One request, one answer.
 */
export const setPreferenceInput = z.object({
  changes: z.array(preferenceChange).min(1).max(64),
});
export type SetPreferenceInput = z.infer<typeof setPreferenceInput>;

export const preferenceSchema = z.object({
  trigger: notificationTrigger,
  channel: notificationChannel,
  enabled: z.boolean(),
});
export type NotificationPreference = z.infer<typeof preferenceSchema>;

/**
 * What the policy screen may change in this package: whether a trigger fires at all, and which
 * channels it is allowed to use. `roles`, `customUserIds` and `mandatory` stay at their seeded
 * values — the screen grows when there is a reason (§6.3).
 */
export const updatePolicyInput = z
  .object({
    enabled: z.boolean().optional(),
    inApp: z.boolean().optional(),
    email: z.boolean().optional(),
    sound: z.boolean().optional(),
    defaultInApp: z.boolean().optional(),
    defaultEmail: z.boolean().optional(),
    defaultSound: z.boolean().optional(),
    /**
     * Who this reaches. Editable only for the four triggers that address an AUDIENCE — the service
     * refuses it on the other sixteen, because "a task notification reaches its assignee" is the
     * module working, not a setting, and a screen that let somebody clear it would let them break
     * the module quietly.
     *
     * `null` is a real value here (route by `roles` alone), which is why it is a union rather than
     * `.optional()` on a string: absent means "not touching it".
     */
    recipientGate: z.union([z.literal(null), z.string().min(1)]).optional(),
    customUserIds: z.array(uuid).max(50).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });
export type UpdatePolicyInput = z.infer<typeof updatePolicyInput>;

export const policySchema = z.object({
  trigger: notificationTrigger,
  enabled: z.boolean(),
  mandatory: z.boolean(),
  roles: z.array(z.string()),
  inApp: z.boolean(),
  email: z.boolean(),
  sound: z.boolean(),
  defaultInApp: z.boolean(),
  defaultEmail: z.boolean(),
  defaultSound: z.boolean(),
  /** the gate that decides the audience, or null when `roles` alone decides */
  recipientGate: z.string().nullable(),
  /** named people, added on top of whatever the gate or the roles resolve to */
  customUserIds: z.array(uuid),
});
export type NotificationPolicy = z.infer<typeof policySchema>;
