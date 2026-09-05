/**
 * Every query the bell needs, and the seven reads the nightly sweep scans.
 *
 * The sweep's reads reach across Tasks, Calendar, Payments and Mailouts, which looks like a layer
 * violation and is not one: the rule (architecture.md §3) is that queries live in a repository,
 * and the alternative — asking four modules each to export a "things to notify about" read —
 * would put notification concerns inside four modules that have no business knowing this one
 * exists.
 */
import type { NotificationChannel } from "@shared/notifications.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../core/db.js";

// ── the tray ─────────────────────────────────────────────────────────────────

/** The tray renders unread rows, newest first, capped. There is no paging and no history screen. */
export function listUnread(userId: string, take: number) {
  return prisma.notification.findMany({
    where: { userId, readAt: null },
    orderBy: { createdAt: "desc" },
    take,
  });
}

/**
 * Counted across ALL unread rows, not the page. A badge that stopped at the tray's cap would be a
 * lie about how much is waiting.
 */
export function countUnread(userId: string) {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

/**
 * One row, scoped to its owner. The scope is the authorization: a notification is addressed to a
 * person, so "not yours" and "does not exist" are the same answer, and neither leaks the other's
 * existence.
 */
export function findOwn(userId: string, id: string) {
  return prisma.notification.findFirst({ where: { id, userId }, select: { id: true } });
}

/** Scoped by userId as well as id: an id alone would let anyone dismiss anyone's row. */
export function markRead(userId: string, id: string) {
  return prisma.notification.updateMany({
    where: { id, userId, readAt: null },
    data: { readAt: new Date() },
  });
}

export function markAllRead(userId: string) {
  return prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
}

/**
 * Retention: read rows older than the cutoff go; unread rows never do, at any age — a
 * notification nobody has seen has not done its job yet.
 */
export function purgeReadBefore(cutoff: Date) {
  return prisma.notification.deleteMany({
    where: { readAt: { not: null, lt: cutoff } },
  });
}

// ── the two contours ─────────────────────────────────────────────────────────

export function listPolicies() {
  return prisma.notificationPolicy.findMany({ orderBy: { trigger: "asc" } });
}

export function updatePolicy(trigger: string, data: Prisma.NotificationPolicyUpdateInput) {
  return prisma.notificationPolicy.update({ where: { trigger }, data });
}

export function findPolicy(trigger: string) {
  return prisma.notificationPolicy.findUnique({ where: { trigger } });
}

export function listPreferences(userId: string) {
  return prisma.notificationPreference.findMany({ where: { userId } });
}

export function setPreference(
  userId: string,
  trigger: string,
  channel: NotificationChannel,
  enabled: boolean,
) {
  return prisma.notificationPreference.upsert({
    where: { userId_trigger_channel: { userId, trigger, channel } },
    update: { enabled },
    create: { userId, trigger, channel, enabled },
  });
}

/** "Follow the default" is the ABSENCE of a row, never a third stored value (§4.3). */
export function clearPreference(userId: string, trigger: string, channel: NotificationChannel) {
  return prisma.notificationPreference.deleteMany({ where: { userId, trigger, channel } });
}

/**
 * The two schedule settings, straight off the firm singleton. Here rather than in the settings
 * module because the sweep needs them and modules may not import each other — the same rule the
 * emitter lives in `core/` for.
 */
export function findFirmNotificationSettings() {
  return prisma.firmProfile.findUnique({
    where: { id: 1 },
    select: { notifySweepAt: true, notifyDeadlineDays: true },
  });
}

// ── what the sweep scans ─────────────────────────────────────────────────────

/**
 * Open work, its client alive, whose deadline falls in a window.
 *
 * `archivedAt`/`cancelledAt`/`done` are all excluded for the same reason: none of them is work
 * anybody still has to do, and a reminder about finished work teaches people to ignore the bell.
 */
export function tasksWithDeadlineIn(range: {
  gte?: Date;
  lte?: Date;
  lt?: Date;
  equals?: Date;
}) {
  return prisma.task.findMany({
    where: {
      deadline: range,
      done: false,
      cancelledAt: null,
      archivedAt: null,
      OR: [{ clientId: null }, { client: { archivedAt: null } }],
      // a task with nobody on it has nobody to tell — the emitter would resolve to zero anyway,
      // and this keeps the sweep's own scan honest about what it is going to raise
      assignees: { some: {} },
    },
    select: {
      id: true,
      title: true,
      deadline: true,
      client: { select: { firstName: true, lastName: true } },
    },
  });
}

/**
 * Meetings close enough to remind about, with the reminder still ahead of the start.
 *
 * The window is asked for in SQL and narrowed in memory, because "startAt minus this row's own
 * `remindMinutesBefore` is now" compares a column to another column plus the clock, which Prisma
 * cannot express. The widest reminder is an hour, so the query never looks further than that — a
 * handful of rows at any moment, on the `(cancelledAt, startAt)` index that already exists.
 */
export function meetingsToRemind(now: Date, widestMinutes: number) {
  return prisma.meeting.findMany({
    where: {
      cancelledAt: null,
      remindMinutesBefore: { not: null },
      startAt: { gt: now, lte: new Date(now.getTime() + widestMinutes * 60_000) },
    },
    select: { id: true, title: true, startAt: true, remindMinutesBefore: true },
  });
}

export function meetingsStartingBetween(from: Date, to: Date) {
  return prisma.meeting.findMany({
    where: { startAt: { gte: from, lt: to }, cancelledAt: null },
    orderBy: { startAt: "asc" },
    select: { id: true, title: true, startAt: true },
  });
}

/** Unpaid, uncancelled, past its due day. `paidTotal` is denormalized, so this stays one query. */
export function overdueInvoices(today: Date) {
  return prisma.invoice.findMany({
    where: { cancelledAt: null, dueDate: { lt: today } },
    select: {
      id: true,
      number: true,
      amount: true,
      paidTotal: true,
      dueDate: true,
      client: { select: { firstName: true, lastName: true } },
    },
  });
}

/** A timer still running from before today began, in the firm's own clock. */
export function timersRunningSince(before: Date) {
  return prisma.timeEntry.findMany({
    where: { stoppedAt: null, startedAt: { lt: before } },
    select: {
      id: true,
      userId: true,
      startedAt: true,
      task: { select: { id: true, title: true } },
    },
  });
}

/**
 * A mailbox whose last read failed. `bounceError` already exists and is already shown beside the
 * mailbox in Settings — this trigger is the half that reaches somebody who is not looking at that
 * screen.
 */
export function brokenMailboxes() {
  return prisma.mailSenderAccount.findMany({
    where: { active: true, bounceError: { not: null } },
    select: { id: true, name: true, bounceError: true, bounceCheckedAt: true },
  });
}
