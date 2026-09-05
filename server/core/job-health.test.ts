/**
 * The System screen is only as honest as two things: that every job the scheduler runs is
 * described in the registry, and that a run is recorded the way the screen reads it.
 *
 * The first is the same failure the notifications registry already has a test for — a trigger
 * declared and never wired. Here it is the reverse and worse: a job REGISTERED and never
 * described would run for months while the screen said nothing about it, which is exactly the
 * blind spot this whole feature exists to remove.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SYSTEM_JOBS, SYSTEM_JOB_KEYS } from "@shared/system-jobs.js";
import {
  drainSweepFailures,
  readJobHealth,
  recordJobRun,
  resetJobHealth,
} from "./job-health.js";

function serverSources(dir = "server", acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "generated") serverSources(path, acc);
    else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) acc.push(path);
  }
  return acc;
}

describe("the job registry and the scheduler agree", () => {
  const source = serverSources()
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");
  /** every `name:` immediately inside a `registerJob({ … })` call */
  const registered = [...source.matchAll(/registerJob\(\{\s*name:\s*"([^"]+)"/g)].map(
    (m) => m[1],
  );

  it("finds the jobs at all, so a passing test cannot mean the regex broke", () => {
    expect(registered.length).toBeGreaterThanOrEqual(SYSTEM_JOB_KEYS.length);
  });

  it("describes every job the server registers", () => {
    expect(registered.filter((name) => !Object.hasOwn(SYSTEM_JOBS, name))).toEqual([]);
  });

  it("describes no job the server does not register", () => {
    expect(SYSTEM_JOB_KEYS.filter((key) => !registered.includes(key))).toEqual([]);
  });
});

describe("what a finished run leaves behind", () => {
  beforeEach(async () => {
    await resetJobHealth();
  });

  it("records a clean run as ok, with the words the screen shows", async () => {
    await recordJobRun("campaign-sends", {
      ok: true,
      durationMs: 42,
      note: "2 campaigns sent",
    });
    const [row] = await readJobHealth();
    expect(row.lastOkAt).not.toBeNull();
    expect(row.failStreak).toBe(0);
    expect(row.lastNote).toBe("2 campaigns sent");
    expect(row.lastDurationMs).toBe(42);
  });

  it("counts consecutive failures, and forgets the streak the moment one succeeds", async () => {
    await recordJobRun("campaign-sends", { ok: false, durationMs: 1, error: "boom" });
    await recordJobRun("campaign-sends", { ok: false, durationMs: 1, error: "boom" });
    expect((await readJobHealth())[0].failStreak).toBe(2);

    await recordJobRun("campaign-sends", { ok: true, durationMs: 1, note: "fine" });
    const [row] = await readJobHealth();
    expect(row.failStreak).toBe(0);
    // the failure is not erased — it is what tells somebody it happened at all
    expect(row.lastFailedAt).not.toBeNull();
    expect(row.lastError).toBeNull();
  });

  it("owes one report for a run that threw, and one per item for a run that skipped", async () => {
    await recordJobRun("campaign-sends", { ok: false, durationMs: 1, error: "boom" });
    await recordJobRun("read-bounces", { ok: true, durationMs: 1, skipped: 4 });

    const drained = await drainSweepFailures();
    expect(Object.fromEntries(drained.map((d) => [d.sweep, d.count]))).toEqual({
      "campaign-sends": 1,
      "read-bounces": 4,
    });
  });

  it("reports one bad night ONCE — the next report needs a new failure", async () => {
    await recordJobRun("campaign-sends", { ok: true, durationMs: 1, skipped: 2 });
    expect(await drainSweepFailures()).toHaveLength(1);
    expect(await drainSweepFailures()).toHaveLength(0);

    // and a job that has been failing all along is still reported the next time it fails
    await recordJobRun("campaign-sends", { ok: true, durationMs: 1, skipped: 1 });
    expect(await drainSweepFailures()).toHaveLength(1);
  });

  it("loses no failure that lands while a drain is in flight, and never goes negative", async () => {
    // The bug this guards: read-then-set-zero is two round trips, and a job failing in the gap had
    // its debt wiped without anybody being told. `decrement` by what was read survives that gap;
    // the `gte` guard stops a second drainer taking the count below zero, where it would silently
    // absorb the next real failures.
    //
    // One race is not deterministic. The ACCOUNTING over many is: everything recorded is either
    // reported or still owed, and nothing is in neither place.
    const ROUNDS = 25;
    let drained = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const [failures] = await Promise.all([
        drainSweepFailures(),
        recordJobRun("read-bounces", { ok: true, durationMs: 1, skipped: 1 }),
      ]);
      drained += failures.reduce((sum, f) => sum + f.count, 0);
    }
    const [row] = await readJobHealth();
    expect(row.unreported).toBeGreaterThanOrEqual(0);
    expect(drained + row.unreported).toBe(ROUNDS);
  });

  it("survives a restart, which the in-memory register it replaced did not", async () => {
    await recordJobRun("period-invoice-generation", { ok: true, durationMs: 1, skipped: 3 });
    // nothing here simulates a restart better than reading it back through a fresh query: the
    // point is that the debt lives in Postgres and not in this process's heap
    const [row] = await readJobHealth();
    expect(row.unreported).toBe(3);
  });

  it("never stores a password an error quoted back at it", async () => {
    // Prisma names the datasource URL when it cannot reach the database, and this column is both
    // persisted and rendered. The host and the failure are what a person needs; the password is not.
    await recordJobRun("campaign-sends", {
      ok: false,
      durationMs: 1,
      error: "Can not reach database server at `postgresql://buh_crm:s3cr3t@db:5432/buh_crm`",
    });
    const [row] = await readJobHealth();
    expect(row.lastError).not.toContain("s3cr3t");
    // and it is still diagnosable — the host is what tells somebody which server is unreachable
    expect(row.lastError).toContain("db:5432");
  });

  it("keeps a stack trace out of a column meant for one line", async () => {
    await recordJobRun("campaign-sends", {
      ok: false,
      durationMs: 1,
      error: "x".repeat(5_000),
    });
    expect((await readJobHealth())[0].lastError!.length).toBeLessThanOrEqual(500);
  });

  it("does not let a failure to record break the job that was recording it", async () => {
    // a name past the column's limit is the cheapest real write failure to provoke
    await expect(
      recordJobRun("x".repeat(100_000), { ok: true, durationMs: 1 }),
    ).resolves.toBeUndefined();
  });
});

describe("a catch-up on boot", () => {
  beforeEach(async () => {
    await resetJobHealth();
  });

  it("does not stamp a success, or a redeploy would revive a job that has been dead a week", async () => {
    const { registerJob, startScheduler, stopScheduler } = await import("./scheduler.js");
    registerJob({
      name: "catchup-ok-probe",
      cronExpr: "0 0 1 1 *", // never, within a test run
      run: async () => {},
      catchUp: async () => {},
    });
    await startScheduler(silentLog());
    await stopScheduler();

    expect(await readJobHealth()).toEqual([]);
  });

  it("DOES record a catch-up that threw, so a job broken on boot is not invisible until tomorrow", async () => {
    const { registerJob, startScheduler, stopScheduler } = await import("./scheduler.js");
    registerJob({
      name: "catchup-broken-probe",
      cronExpr: "0 0 1 1 *",
      run: async () => {},
      catchUp: async () => {
        throw new Error("database went away");
      },
    });
    await startScheduler(silentLog());
    await stopScheduler();

    const [row] = await readJobHealth();
    expect(row.name).toBe("catchup-broken-probe");
    expect(row.failStreak).toBe(1);
    expect(row.lastError).toBe("database went away");
    expect(row.lastOkAt).toBeNull();
  });
});

/** `startScheduler` wants a Fastify logger and uses only these two methods. */
function silentLog() {
  return { info: () => {}, error: () => {} } as unknown as Parameters<
    typeof import("./scheduler.js").startScheduler
  >[0];
}
