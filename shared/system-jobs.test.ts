/**
 * The status rules, which are the only logic on the System screen and the only thing on it that
 * can be wrong in a way nobody notices — a screen that says "Working" about a dead job is worse
 * than no screen, because it is believed.
 */
import { describe, expect, it } from "vitest";
import {
  SYSTEM_JOBS,
  SYSTEM_JOB_KEYS,
  isHealthy,
  jobStatus,
  type JobHealthRow,
} from "./system-jobs.js";

const NOW = new Date("2026-09-06T09:00:00Z");
const spec = SYSTEM_JOBS["notification-sweep"]; // daily; stale after 36h
const minute = SYSTEM_JOBS["meeting-reminders"]; // every minute; stale after 30m

function row(over: Partial<JobHealthRow> = {}): JobHealthRow {
  return {
    name: "notification-sweep",
    lastOkAt: null,
    lastFailedAt: null,
    failStreak: 0,
    lastSkipped: 0,
    lastDurationMs: null,
    lastNote: null,
    lastError: null,
    ...over,
  };
}
const ago = (mins: number) => new Date(NOW.getTime() - mins * 60_000).toISOString();

describe("what the System screen says about a job", () => {
  it("calls a job that ran cleanly a few hours ago working", () => {
    expect(jobStatus(row({ lastOkAt: ago(120) }), spec, NOW, new Date(ago(600)))).toBe(
      "working",
    );
  });

  it("separates a job that skipped work from one that failed", () => {
    expect(
      jobStatus(row({ lastOkAt: ago(120), lastSkipped: 3 }), spec, NOW, new Date(ago(600))),
    ).toBe("skipping");
    expect(
      jobStatus(row({ lastFailedAt: ago(10), failStreak: 1 }), spec, NOW, new Date(ago(600))),
    ).toBe("failing");
  });

  it("does NOT call a nightly job late on a container that started ten minutes ago", () => {
    // the whole reason `bootedAt` is passed in: a deploy must not paint the screen red for a day,
    // because a screen that is red when everything is fine teaches people the colour means nothing
    expect(jobStatus(undefined, spec, NOW, new Date(ago(10)))).toBe("waiting");
    expect(isHealthy("waiting")).toBe(true);
  });

  it("does call it late once the process has been up longer than the job's own window", () => {
    expect(jobStatus(undefined, spec, NOW, new Date(ago(40 * 60)))).toBe("overdue");
  });

  it("does not blame a job for the time the SERVER was down", () => {
    // an hour of downtime, then a restart a minute ago. The per-minute job has a 30-minute window
    // and last ran before the outage — but it has not had one chance to run yet, and showing a red
    // error the instant a server comes back is how a screen loses its reader on day one.
    const beforeOutage = row({ name: "meeting-reminders", lastOkAt: ago(60) });
    expect(jobStatus(beforeOutage, minute, NOW, new Date(ago(1)))).toBe("working");
    // and once the process HAS been up longer than the window, it is late for real
    expect(jobStatus(beforeOutage, minute, NOW, new Date(ago(45)))).toBe("overdue");
  });

  it("holds each job to ITS OWN window, not one shared number", () => {
    const twoHours = row({ lastOkAt: ago(120) });
    const booted = new Date(ago(600));
    // two hours is nothing for a nightly sweep and a disaster for a per-minute job
    expect(jobStatus(twoHours, spec, NOW, booted)).toBe("working");
    expect(jobStatus({ ...twoHours, name: "meeting-reminders" }, minute, NOW, booted)).toBe(
      "overdue",
    );
  });

  it("treats a job that has only ever failed as failing, not as never run", () => {
    const onlyFailed = row({ lastFailedAt: ago(5), failStreak: 2 });
    expect(jobStatus(onlyFailed, spec, NOW, new Date(ago(10)))).toBe("failing");
  });

  it("stops calling it failing once it succeeds again", () => {
    const recovered = row({ lastFailedAt: ago(300), lastOkAt: ago(30), failStreak: 0 });
    expect(jobStatus(recovered, spec, NOW, new Date(ago(600)))).toBe("working");
  });

  it("describes every job the scheduler runs, in words and not in cron", () => {
    for (const key of SYSTEM_JOB_KEYS) {
      const s = SYSTEM_JOBS[key];
      // the label is prose, not the key: `sessions:cleanup` → "Clearing expired sign-ins"
      expect(s.label, key).not.toBe(key);
      expect(s.label, key).toContain(" ");
      expect(s.label, key).not.toMatch(/[:_]/);
      expect(s.whenBad.length, key).toBeGreaterThan(20);
      expect(s.staleAfterMinutes, key).toBeGreaterThan(0);
      // a cron expression on a screen for a bookkeeper is a screen for somebody else
      expect(s.cadence, key).not.toMatch(/\*/);
    }
  });
});
