import { z } from "zod";
import { uuid } from "./common.js";

/**
 * Meetings and the calendar (S8).
 *
 * A meeting is an **instant plus a length** — unlike a deadline or a due date, which are calendar
 * DAYS (see shared/dates.ts). Both land on the same screen, so the calendar keeps them in separate
 * lanes: meetings in the hour grid, deadlines in the all-day row above it. Conflating the two is
 * how "due 26.07" ends up drawn at midnight.
 *
 * The overlap rule itself lives in `shared/meetings.ts`, zod-free, because the meeting form warns
 * about a clash as you type and must not pull the schema runtime into the browser bundle.
 */

export const MEETING_DURATION_PRESETS = [15, 30, 45, 60, 90] as const;

/** What a new meeting starts at. Short check-ins are the common case here (user, 2026-08-06). */
export const DEFAULT_MEETING_MINUTES = 15;

/** The window a calendar view may ask for. A month view is ~6 weeks, so this leaves room. */
export const MAX_CALENDAR_RANGE_DAYS = 62;

export const meetingSchema = z.object({
  id: uuid,
  title: z.string().min(1),
  /** client OR lead OR neither (an internal meeting) — never both */
  clientId: uuid.nullable(),
  leadId: uuid.nullable(),
  /** WHO at the client, when it is worth saying — a refinement of `clientId`, never a target */
  personId: uuid.nullable(),
  /** what the meeting is about, when it maps to a catalog service */
  serviceId: uuid.nullable(),
  startAt: z.iso.datetime(),
  durationMinutes: z.number().int().positive(),
  /** minutes before the start to remind, or null for no reminder */
  remindMinutesBefore: z.number().int().nullable(),
  /** free text, not `z.url()`: a dial-in number or an internal tool is a legitimate answer */
  link: z.string().nullable(),
  description: z.string().nullable(),
  participantIds: z.array(uuid),
  /** labels resolved server-side, so the calendar never depends on a clients page being loaded */
  clientName: z.string().nullable(),
  leadName: z.string().nullable(),
  personName: z.string().nullable(),
  serviceName: z.string().nullable(),
  /** the task opened alongside it, if one was (see `task` on the create input) */
  taskId: uuid.nullable(),
  createdById: uuid.nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type Meeting = z.infer<typeof meetingSchema>;

// ── inputs ───────────────────────────────────────────────────────────────────

const optionalText = z
  .string()
  .transform((v) => v.trim() || null)
  .nullable()
  .optional();

/**
 * Opening a task alongside the meeting is optional, and when the meeting is a client's the firm
 * chooses what kind of work it is (user, 2026-08-04):
 *
 * - **internal** — the firm's own time, attributed to the client for reporting. Bills nothing.
 * - **service** — real client work, routed through one of their subscriptions, exactly like any
 *   other client task. A one-time service will issue its invoice per its own trigger.
 *
 * A LEAD's meeting has no choice to make: a lead holds no subscriptions, so its task is always
 * free internal work. Same for a meeting with neither.
 */
export const meetingTaskInput = z.object({
  mode: z.enum(["internal", "service"]),
  /** required when mode = "service" — one of the client's subscriptions */
  subscriptionId: uuid.nullable().optional(),
});
export type MeetingTaskInput = z.infer<typeof meetingTaskInput>;

/**
 * How long before the start to remind whoever is coming. `null` = no reminder, which is the
 * default: a booking made without thinking about it must behave exactly as it did before this
 * existed (user, 2026-09-06).
 *
 * A fixed set rather than a free number — five choices are a decision somebody makes in a second,
 * and an open integer is a field people mistype 150 into.
 */
export const REMINDER_CHOICES = [5, 15, 30, 60] as const;
export const remindMinutesBefore = z
  .union([z.literal(5), z.literal(15), z.literal(30), z.literal(60)])
  .nullable();

const meetingFields = z.object({
  title: z.string().trim().min(1, "Required").max(200),
  clientId: uuid.nullable().optional(),
  leadId: uuid.nullable().optional(),
  /**
   * The contact at the client, when the meeting is with a particular person rather than with the
   * firm at large. Only meaningful alongside `clientId` — a lead carries no contacts and an
   * internal meeting has no client. The server checks the person actually belongs to that client:
   * an id from somewhere else must not quietly attach a stranger's contact details.
   *
   * It IS editable after the fact, unlike the target — you often learn who you are dealing with
   * after the meeting is booked, and moving it changes nothing a linked task points at.
   */
  personId: uuid.nullable().optional(),
  serviceId: uuid.nullable().optional(),
  startAt: z.iso.datetime(),
  durationMinutes: z
    .number()
    .int()
    .min(5)
    .max(24 * 60),
  remindMinutesBefore: remindMinutesBefore.optional(),
  link: optionalText,
  description: optionalText,
  /** the team members expected there; the organiser is added server-side if left out */
  participantIds: z.array(uuid).max(50).default([]),
});

export const createMeetingInput = meetingFields
  .extend({
    /** omit (or null) to open no task at all */
    task: meetingTaskInput.nullable().optional(),
  })
  .refine((v) => !(v.clientId && v.leadId), {
    path: ["leadId"],
    message: "Pick a client or a lead, not both",
  })
  .refine((v) => !v.personId || !!v.clientId, {
    path: ["personId"],
    message: "A contact person belongs to a client — pick the client too",
  })
  .refine((v) => v.task?.mode !== "service" || !!v.clientId, {
    path: ["task"],
    message: "Only a client's meeting can route its task through a service",
  })
  .refine((v) => v.task?.mode !== "service" || !!v.task.subscriptionId, {
    path: ["task", "subscriptionId"],
    message: "Pick which of the client's services the work goes through",
  });
export type CreateMeetingInput = z.infer<typeof createMeetingInput>;

/**
 * Re-targeting isn't supported — a linked task would be left pointing at the wrong client.
 *
 * `task` may be sent to attach one to a meeting that has none: booking fast and deciding later
 * that it needs preparing is the ordinary case (user, 2026-08-06). It cannot REPLACE an existing
 * task — the server refuses that, because the old one has already been worked on.
 *
 * The create input's cross-field refines (service mode needs a client) can't live here: this shape
 * deliberately omits `clientId`, so only the server knows the target. It validates there instead.
 */
export const updateMeetingInput = meetingFields
  .omit({ clientId: true, leadId: true })
  .partial()
  .extend({
    cancelled: z.boolean().optional(),
    task: meetingTaskInput.nullable().optional(),
  });
export type UpdateMeetingInput = z.infer<typeof updateMeetingInput>;

// ── calendar read ────────────────────────────────────────────────────────────

export const calendarQuery = z.object({
  /** inclusive first day and EXCLUSIVE last day of the window, as calendar days */
  from: z.iso.date(),
  to: z.iso.date(),
  /** narrow to one person: their meetings, and the tasks assigned to them */
  userId: uuid.optional(),
  clientId: uuid.optional(),
  /** drop a lane entirely — the chips above the grid */
  meetings: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v !== "false"),
  deadlines: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v !== "false"),
});
export type CalendarQuery = z.infer<typeof calendarQuery>;

/**
 * A task's deadline, projected onto the calendar. Read-only and deliberately thin: it carries just
 * enough to draw a chip and link back to the task, because the board is where work is actually
 * done. Anything richer here would be a second task UI to keep in step with the first.
 */
export const deadlineItemSchema = z.object({
  taskId: uuid,
  title: z.string(),
  /** the calendar DAY it is due — a deadline is a whole day, never an instant */
  day: z.iso.date(),
  clientName: z.string().nullable(),
  leadName: z.string().nullable(),
  assigneeIds: z.array(uuid),
  overdue: z.boolean(),
});
export type DeadlineItem = z.infer<typeof deadlineItemSchema>;

export const calendarSchema = z.object({
  meetings: z.array(meetingSchema),
  deadlines: z.array(deadlineItemSchema),
});
export type Calendar = z.infer<typeof calendarSchema>;

/** Who is already booked over a proposed slot — a warning, never a refusal. */
export const meetingConflictSchema = z.object({
  meetingId: uuid,
  title: z.string(),
  startAt: z.iso.datetime(),
  durationMinutes: z.number().int(),
  /** the participants this meeting and the proposed one have in common */
  userIds: z.array(uuid),
});
export type MeetingConflict = z.infer<typeof meetingConflictSchema>;
