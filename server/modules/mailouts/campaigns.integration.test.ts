import argon2 from "argon2";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { prisma } from "../../core/db.js";
import { testOutbox } from "../../core/email.js";
import { config } from "../../core/config.js";
import { fromDate } from "../../core/dates.js";
import { runDueCampaigns } from "./index.js";

/**
 * Campaigns (S10.1) — a planned mailout with a date.
 *
 * The two things worth being paranoid about, and what proves each:
 *
 *   **It fires once.** The sweep runs nightly AND on every boot, so "already sent" cannot be
 *   something the sweep remembers — `UNIQUE(campaignId, periodKey)` on Mailout is what makes a
 *   second attempt fail rather than duplicate. Tested by running the sweep twice.
 *
 *   **It fires through the same path a person does.** A scheduled letter must honour an opt-out,
 *   carry the unsubscribe link and the postal address, and land in the Sent log exactly like a
 *   hand-pressed send. Tested by checking the log, the letter and the skip reasons, not the code.
 */

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie: string;
let clientA: string; // full card
let clientB: string; // no email — always skipped
let clientC: string; // subscribed, used for the opt-out flow
let templateId: string;

const PAST = "2020-03-10"; // safely behind any real "today", so the sweep fires immediately
const FUTURE = "2099-01-15";

/**
 * Fixed instants, pinned to the FIRM's clock rather than to UTC.
 *
 * `sendAt` is compared against the firm's local time, so a test that picked instants in UTC would
 * be testing a different hour in every deployment timezone — and, the first time I wrote it, the
 * wrong one here.
 */
const clockOf = (at: Date) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: config.TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);

function dayOf(at: Date) {
  const { y, m, d } = fromDate(at, config.TZ);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The instant in mid-June 2026 at which the firm's clock reads exactly 12:00. */
function firmNoon(): Date {
  for (let h = 0; h < 48; h++) {
    const at = new Date(Date.UTC(2026, 5, 15, h, 0, 0));
    if (clockOf(at) === "12:00") return at;
  }
  throw new Error("no instant reads 12:00 on the firm clock");
}
const NOON = firmNoon();
/** …and eight hours later, which is 20:00 the same local day. */
const EVENING = new Date(NOON.getTime() + 8 * 3_600_000);

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  return raw.split(";")[0];
}

async function settled(mailoutId: string) {
  for (let i = 0; i < 80; i++) {
    const rows = await prisma.mailoutRecipient.findMany({ where: { mailoutId } });
    if (rows.length > 0 && !rows.some((r) => r.status === "queued")) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("delivery did not settle");
}

const to = (...clientIds: string[]) => clientIds.map((clientId) => ({ clientId }));

/**
 * Wait until nothing anywhere is still being delivered.
 *
 * Delivery runs AFTER the response — that is the whole design — so a test that fires a campaign
 * and asserts on the log can finish while letters are still going out. Wiping the tables under a
 * run in flight then throws inside the background loop and, worse, lands its letters in the NEXT
 * test's outbox. Two tests failed exactly that way before this existed.
 */
async function quiet() {
  for (let i = 0; i < 120; i++) {
    if ((await prisma.mailoutRecipient.count({ where: { status: "queued" } })) === 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("delivery never went quiet");
}

async function makeCampaign(over: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/api/mailouts/campaigns",
    headers: { cookie },
    payload: {
      name: `Campaign ${Math.round(performance.now() * 1000)}`,
      templateId,
      startsOn: FUTURE,
      recipients: to(clientA),
      ...over,
    },
  });
  return res;
}

/** The Mailout a campaign produced for one occurrence. */
async function runOf(campaignId: string, periodKey: string) {
  const row = await prisma.mailout.findFirst({ where: { campaignId, periodKey } });
  if (!row) throw new Error(`no run for ${campaignId} @ ${periodKey}`);
  return row;
}

beforeAll(async () => {
  app = await buildApp();
  await prisma.clientMailPreference.deleteMany();
  await prisma.mailoutRecipient.deleteMany();
  await prisma.mailout.deleteMany();
  await prisma.campaignRecipient.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.emailTemplate.deleteMany();
  await prisma.mailSenderAccount.deleteMany();
  await prisma.company.deleteMany();
  await prisma.client.deleteMany();
  await prisma.session.deleteMany();
  await prisma.firmProfile.deleteMany();
  await prisma.file.deleteMany();
  await prisma.user.deleteMany();

  await prisma.firmProfile.create({
    data: {
      id: 1,
      name: "ILLION Tax & Accounting",
      postalAddress: "1200 Main St, Suite 4, Charlotte, NC 28202",
    },
  });
  await prisma.mailSenderAccount.create({
    data: {
      name: "Main",
      fromName: "ILLION Tax & Accounting",
      fromEmail: "info@illion.tax",
      isDefault: true,
    },
  });
  await prisma.user.create({
    data: {
      email: "admin@example.com",
      passwordHash: await argon2.hash("password-123"),
      firstName: "Ada",
      lastName: "Admin",
      role: "admin",
      status: "active",
    },
  });

  const a = await prisma.client.create({
    data: { firstName: "Olena", lastName: "Kovalenko", email: "olena@example.com" },
  });
  const b = await prisma.client.create({ data: { firstName: "Nadia", lastName: "NoMail" } });
  const c = await prisma.client.create({
    data: { firstName: "Petro", lastName: "Bond", email: "petro@example.com" },
  });
  clientA = a.id;
  clientB = b.id;
  clientC = c.id;

  const t = await prisma.emailTemplate.create({
    data: {
      name: "Season news",
      subject: "News for {{first_name}}",
      heading: null,
      body: "Hello {{first_name}}, here is what changed.",
      kind: "commercial",
      active: true,
    },
  });
  templateId = t.id;

  cookie = cookieOf(
    await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "password-123" },
    }),
  );
});

afterAll(async () => {
  await quiet();
  // Left behind, these block `company.deleteMany()` in every suite that runs after this one —
  // MailoutRecipient.companyId is ON DELETE RESTRICT on purpose.
  await prisma.mailoutRecipient.deleteMany();
  await prisma.mailout.deleteMany();
  await prisma.campaignRecipient.deleteMany();
  await prisma.campaign.deleteMany();
  await app.close();
});

beforeEach(async () => {
  await quiet();
  testOutbox.length = 0;
  await prisma.mailoutRecipient.deleteMany();
  await prisma.mailout.deleteMany();
  await prisma.campaignRecipient.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.clientMailPreference.deleteMany();
});

describe("planning", () => {
  it("is due on the date it was given", async () => {
    const res = await makeCampaign({ startsOn: FUTURE });
    expect(res.statusCode).toBe(201);
    expect(res.json().nextRunOn).toBe(FUTURE);
    expect(res.json().status).toBe("scheduled");
    expect(res.json().recipientCount).toBe(1);
  });

  it("refuses a second campaign by the same name", async () => {
    await makeCampaign({ name: "Spring news" });
    const clash = await makeCampaign({ name: "spring NEWS" });
    expect(clash.statusCode).toBe(409);
  });

  it("refuses an inactive template — a schedule pointing at one would fail silently on the day", async () => {
    const dormant = await prisma.emailTemplate.create({
      data: { name: "Old", subject: "s", body: "b", kind: "commercial", active: false },
    });
    const res = await makeCampaign({ templateId: dormant.id });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/inactive/i);
    await prisma.emailTemplate.delete({ where: { id: dormant.id } });
  });

  it("refuses an end date before the start, and one on a campaign with no rhythm", async () => {
    expect(
      (await makeCampaign({ startsOn: "2099-02-01", endsOn: "2099-01-01", rhythm: "monthly" }))
        .statusCode,
    ).toBe(400);
    expect(
      (await makeCampaign({ startsOn: "2099-01-01", endsOn: "2099-02-01" })).statusCode,
    ).toBe(400);
  });
});

describe("firing", () => {
  it("sends on the date, through the ordinary log", async () => {
    const c = (await makeCampaign({ startsOn: PAST, recipients: to(clientA, clientB) })).json();

    const { fired } = await runDueCampaigns();
    expect(fired).toBe(1);

    const run = await runOf(c.id, PAST);
    const rows = await settled(run.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(1);
    expect(rows.find((r) => r.clientId === clientB)?.reason).toMatch(/no email/i);

    const mail = testOutbox.at(-1)!;
    expect(mail.to).toBe("olena@example.com");
    expect(mail.subject).toBe("News for Olena");
    // a commercial letter, so both of the things that make one lawful are in it
    expect(mail.html).toContain("Charlotte, NC 28202");
    expect(mail.html).toContain("/api/mailouts/unsubscribe/");

    // it appears in the Sent log exactly like a hand-pressed send
    const log = await app.inject({ method: "GET", url: "/api/mailouts", headers: { cookie } });
    expect(log.json().items.some((m: { id: string }) => m.id === run.id)).toBe(true);
  });

  /**
   * The one that matters most. The sweep runs nightly and on every boot, so a server restarted
   * three times in an evening would send three copies of the same newsletter if "already ran" were
   * something the sweep tried to remember rather than something the database refuses.
   */
  it("fires once per date, however many times the sweep runs", async () => {
    const c = (await makeCampaign({ startsOn: PAST, rhythm: "monthly" })).json();

    await runDueCampaigns();
    const firstRun = await runOf(c.id, PAST);
    await settled(firstRun.id);
    const sentAfterFirst = testOutbox.length;

    await runDueCampaigns();
    await runDueCampaigns();

    expect(await prisma.mailout.count({ where: { campaignId: c.id } })).toBe(1);
    expect(testOutbox).toHaveLength(sentAfterFirst);
  });

  it("a one-off is finished once it has gone", async () => {
    const c = (await makeCampaign({ startsOn: PAST })).json();
    await runDueCampaigns();

    const after = await app.inject({
      method: "GET",
      url: `/api/mailouts/campaigns/${c.id}`,
      headers: { cookie },
    });
    expect(after.json().status).toBe("finished");
    expect(after.json().nextRunOn).toBeNull();
    expect(after.json().runCount).toBe(1);
  });

  /**
   * Late, but never a backlog. A monthly campaign whose start is years back must send ONE letter
   * and line up the next one — not one per missed month. The task and invoice sweeps deliberately
   * do the opposite, because a missing invoice is a missing fact.
   */
  it("catches up with one letter, not with every month it missed", async () => {
    const c = (await makeCampaign({ startsOn: PAST, rhythm: "monthly" })).json();
    await runDueCampaigns();

    expect(await prisma.mailout.count({ where: { campaignId: c.id } })).toBe(1);

    const after = (
      await app.inject({
        method: "GET",
        url: `/api/mailouts/campaigns/${c.id}`,
        headers: { cookie },
      })
    ).json();
    expect(after.status).toBe("scheduled");
    // the next date is ahead of us, not the month after the one it missed in 2020
    expect(Date.parse(after.nextRunOn)).toBeGreaterThan(Date.now());
    // …and it is still the 10th, the day the firm chose
    expect(after.nextRunOn.endsWith("-10")).toBe(true);
  });

  it("uses the list as it stands on the day, not as it stood when planned", async () => {
    const c = (await makeCampaign({ startsOn: PAST, recipients: to(clientA) })).json();

    const edited = await app.inject({
      method: "PUT",
      url: `/api/mailouts/campaigns/${c.id}`,
      headers: { cookie },
      payload: {
        name: c.name,
        templateId,
        startsOn: PAST,
        recipients: to(clientA, clientC),
      },
    });
    expect(edited.statusCode).toBe(200);

    await runDueCampaigns();
    const rows = await settled((await runOf(c.id, PAST)).id);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.email))).toEqual(
      new Set(["olena@example.com", "petro@example.com"]),
    );
  });

  it("does not fire a stopped campaign, and picks it up again when restarted", async () => {
    const c = (await makeCampaign({ startsOn: PAST, rhythm: "monthly" })).json();

    await app.inject({
      method: "POST",
      url: `/api/mailouts/campaigns/${c.id}/active`,
      headers: { cookie },
      payload: { active: false },
    });
    await runDueCampaigns();
    expect(await prisma.mailout.count({ where: { campaignId: c.id } })).toBe(0);

    const restarted = await app.inject({
      method: "POST",
      url: `/api/mailouts/campaigns/${c.id}/active`,
      headers: { cookie },
      payload: { active: true },
    });
    expect(restarted.json().status).toBe("scheduled");
    // stopping before it ever ran must not have eaten its first date
    expect(restarted.json().nextRunOn).toBe(PAST);

    await runDueCampaigns();
    expect(await prisma.mailout.count({ where: { campaignId: c.id } })).toBe(1);
  });

  /**
   * Belt AND braces, tested separately.
   *
   * Stopping a campaign clears its date as well as its status, so the test above passes even with
   * the status filter removed — it was only ever proving the date half. This one writes the
   * inconsistent state the API cannot produce (stopped, but still carrying a date) and shows the
   * sweep refuses it anyway. Without this, a future change that set the status without clearing
   * the date would start sending stopped campaigns, and nothing here would notice.
   */
  it("refuses a stopped campaign even if a date is somehow still on it", async () => {
    const c = (await makeCampaign({ startsOn: PAST, rhythm: "monthly" })).json();
    await prisma.campaign.update({
      where: { id: c.id },
      data: { status: "stopped", nextRunOn: new Date(`${PAST}T00:00:00.000Z`) },
    });

    const { fired } = await runDueCampaigns();
    expect(fired).toBe(0);
    expect(await prisma.mailout.count({ where: { campaignId: c.id } })).toBe(0);
  });

  /**
   * The time of day is a promise the screen makes — "goes out at 09:00" — and an hourly sweep that
   * ignored it would send the 17:00 newsletter at one in the morning. Swept at a FIXED instant, so
   * this does not quietly become a test that passes twenty-three hours a day.
   */
  it("waits for the hour the firm chose, on the day itself", async () => {
    const today = dayOf(NOON);
    const later = (await makeCampaign({ startsOn: today, sendAt: "19:00" })).json();
    const earlier = (await makeCampaign({ startsOn: today, sendAt: "08:00" })).json();

    // swept at 12:00 on the firm's clock
    await runDueCampaigns(NOON);
    expect(await prisma.mailout.count({ where: { campaignId: earlier.id } })).toBe(1);
    expect(await prisma.mailout.count({ where: { campaignId: later.id } })).toBe(0);

    // …and the evening one goes when its hour comes, same day
    await runDueCampaigns(EVENING);
    expect(await prisma.mailout.count({ where: { campaignId: later.id } })).toBe(1);
  });

  /**
   * A date already behind us does NOT wait for its hour. It is late, and holding a letter missed
   * at 23:00 back for another whole day would turn one hour of downtime into a day of it.
   */
  it("does not make a late campaign wait for its hour as well", async () => {
    const c = (await makeCampaign({ startsOn: PAST, sendAt: "23:00" })).json();
    await runDueCampaigns(NOON);
    expect(await prisma.mailout.count({ where: { campaignId: c.id } })).toBe(1);
  });

  /**
   * A stopped campaign has one invariant — stopped means no date — and editing one used to break
   * it: the list then showed "Next 13/08" beside a Stopped pill, for a campaign the sweep would
   * (correctly) refuse to send. A date on screen that nothing will act on is worse than none.
   */
  it("keeps a stopped campaign dateless when it is edited", async () => {
    const c = (await makeCampaign({ startsOn: FUTURE, rhythm: "monthly" })).json();
    await app.inject({
      method: "POST",
      url: `/api/mailouts/campaigns/${c.id}/active`,
      headers: { cookie },
      payload: { active: false },
    });

    const edited = await app.inject({
      method: "PUT",
      url: `/api/mailouts/campaigns/${c.id}`,
      headers: { cookie },
      payload: {
        name: c.name,
        templateId,
        rhythm: "monthly",
        startsOn: FUTURE,
        recipients: to(clientA, clientC),
      },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().status).toBe("stopped");
    expect(edited.json().nextRunOn).toBeNull();
    // the edit itself still took effect
    expect(edited.json().recipients).toHaveLength(2);

    // …and starting it again derives the date afresh
    const started = await app.inject({
      method: "POST",
      url: `/api/mailouts/campaigns/${c.id}/active`,
      headers: { cookie },
      payload: { active: true },
    });
    expect(started.json().nextRunOn).toBe(FUTURE);
  });
});

/**
 * A hand-picked list of days, rather than a rule.
 *
 * An accounting firm's calendar is 15 March, 15 April, 15 September — deadlines, not a rhythm.
 * The list is the only source of truth here: `startsOn` is derived from it, and which day already
 * fired is still `Mailout.periodKey`, so nothing new can drift out of step.
 */
describe("campaigns on set dates", () => {
  it("takes the days as typed and lines up the earliest", async () => {
    const res = await makeCampaign({
      rhythm: "dates",
      startsOn: "2099-12-31", // deliberately wrong — the list decides, not this
      dates: ["2099-09-15", "2099-03-15", "2099-04-15"],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().dates).toEqual(["2099-03-15", "2099-04-15", "2099-09-15"]);
    expect(res.json().startsOn).toBe("2099-03-15");
    expect(res.json().nextRunOn).toBe("2099-03-15");
  });

  it("refuses an empty list, and the same day twice", async () => {
    expect((await makeCampaign({ rhythm: "dates", dates: [] })).statusCode).toBe(400);
    expect(
      (await makeCampaign({ rhythm: "dates", dates: ["2099-03-15", "2099-03-15"] })).statusCode,
    ).toBe(400);
  });

  it("refuses a stop date — a list ends by running out", async () => {
    const res = await makeCampaign({
      rhythm: "dates",
      dates: ["2099-03-15"],
      endsOn: "2099-12-31",
    });
    expect(res.statusCode).toBe(400);
  });

  it("walks the list one day at a time and then finishes", async () => {
    const [first, second] = ["2026-03-15", "2026-04-15"];
    const c = (
      await makeCampaign({ rhythm: "dates", dates: [first, second], recipients: to(clientA) })
    ).json();
    const read = async () =>
      (
        await app.inject({
          method: "GET",
          url: `/api/mailouts/campaigns/${c.id}`,
          headers: { cookie },
        })
      ).json();

    // swept five days after the first date and before the second
    await runDueCampaigns(new Date("2026-03-20T12:00:00.000Z"));
    await settled((await runOf(c.id, first)).id);
    expect(await prisma.mailout.count({ where: { campaignId: c.id } })).toBe(1);
    expect(await read()).toMatchObject({ status: "scheduled", nextRunOn: second });

    await runDueCampaigns(new Date("2026-04-20T12:00:00.000Z"));
    await settled((await runOf(c.id, second)).id);
    expect(await read()).toMatchObject({ status: "finished", nextRunOn: null, runCount: 2 });
    expect(await prisma.mailout.count({ where: { campaignId: c.id } })).toBe(2);
  });

  /**
   * The same no-backlog rule a rhythm follows, and for the same reason: a "15 March deadline"
   * letter arriving in August is worse than one that did not arrive. The due day goes out, the
   * ones behind it are skipped, and the campaign lands on the next day still ahead — here, none.
   */
  it("does not send the days it slept through", async () => {
    const c = (
      await makeCampaign({
        rhythm: "dates",
        dates: ["2020-03-10", "2020-04-10", "2020-05-10"],
        recipients: to(clientA),
      })
    ).json();

    await runDueCampaigns();
    await settled((await runOf(c.id, "2020-03-10")).id);

    expect(await prisma.mailout.count({ where: { campaignId: c.id } })).toBe(1);
    const after = (
      await app.inject({
        method: "GET",
        url: `/api/mailouts/campaigns/${c.id}`,
        headers: { cookie },
      })
    ).json();
    expect(after.status).toBe("finished");
  });

  it("fires once per day however many times the sweep runs", async () => {
    const c = (
      await makeCampaign({ rhythm: "dates", dates: [PAST], recipients: to(clientA) })
    ).json();
    await runDueCampaigns();
    await settled((await runOf(c.id, PAST)).id);
    await runDueCampaigns();
    await runDueCampaigns();
    expect(await prisma.mailout.count({ where: { campaignId: c.id } })).toBe(1);
  });

  it("can have days added and removed until they come round", async () => {
    const c = (await makeCampaign({ rhythm: "dates", dates: ["2099-03-15"] })).json();
    const edited = await app.inject({
      method: "PUT",
      url: `/api/mailouts/campaigns/${c.id}`,
      headers: { cookie },
      payload: {
        name: c.name,
        templateId,
        rhythm: "dates",
        startsOn: "2099-03-15",
        dates: ["2099-06-01", "2099-01-20"],
        recipients: to(clientA),
      },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().dates).toEqual(["2099-01-20", "2099-06-01"]);
    // the earliest moved earlier, and so did what is due next
    expect(edited.json().nextRunOn).toBe("2099-01-20");
    expect(edited.json().startsOn).toBe("2099-01-20");
  });
});

describe("consent", () => {
  it("skips a client who unsubscribed between planning and the date", async () => {
    const c = (await makeCampaign({ startsOn: PAST, recipients: to(clientA, clientC) })).json();

    await app.inject({
      method: "PATCH",
      url: `/api/mailouts/clients/${clientC}/subscription`,
      headers: { cookie },
      payload: { subscribed: false },
    });

    await runDueCampaigns();
    const rows = await settled((await runOf(c.id, PAST)).id);
    const theirs = rows.find((r) => r.clientId === clientC)!;
    expect(theirs.status).toBe("skipped");
    expect(theirs.reason).toMatch(/unsubscribed/i);
    expect(testOutbox.map((m) => m.to)).toEqual(["olena@example.com"]);
  });

  /**
   * The exemption that makes the choice of kind a real one: a transactional campaign is a bill or
   * a document request, and a client who unsubscribed from news still has to receive it.
   */
  it("a transactional campaign reaches an unsubscribed client, with no unsubscribe link", async () => {
    const t = await prisma.emailTemplate.create({
      data: {
        name: "Docs due",
        subject: "Documents due",
        body: "Hello {{first_name}}, please send your documents.",
        kind: "transactional",
        active: true,
      },
    });
    await app.inject({
      method: "PATCH",
      url: `/api/mailouts/clients/${clientC}/subscription`,
      headers: { cookie },
      payload: { subscribed: false },
    });

    const c = (
      await makeCampaign({
        startsOn: PAST,
        templateId: t.id,
        kind: "transactional",
        recipients: to(clientC),
      })
    ).json();
    await runDueCampaigns();
    const rows = await settled((await runOf(c.id, PAST)).id);

    expect(rows[0].status).toBe("sent");
    expect(testOutbox[0].to).toBe("petro@example.com");
    expect(testOutbox[0].html).not.toContain("/unsubscribe/");

    // the campaign has to go first: Campaign.templateId is RESTRICT, so a template a schedule
    // still points at cannot be deleted — which is the point of that constraint
    await quiet();
    await prisma.mailoutRecipient.deleteMany();
    await prisma.mailout.deleteMany();
    await prisma.campaign.deleteMany();
    await prisma.emailTemplate.delete({ where: { id: t.id } });
  });

  /**
   * A commercial campaign with no postal address is unlawful. Refusing outright would leave it due
   * tomorrow and every day after, failing where nobody looks; recording the run with everything
   * skipped puts the same fact in the log, once, with the fix in the reason.
   */
  it("records a run it could not lawfully send, rather than retrying forever in silence", async () => {
    await prisma.firmProfile.update({ where: { id: 1 }, data: { postalAddress: null } });
    const c = (await makeCampaign({ startsOn: PAST })).json();

    await runDueCampaigns();
    const rows = await prisma.mailoutRecipient.findMany({
      where: { mailoutId: (await runOf(c.id, PAST)).id },
    });
    expect(rows.every((r) => r.status === "skipped")).toBe(true);
    expect(rows[0].reason).toMatch(/postal address/i);
    expect(testOutbox).toHaveLength(0);

    // and it moved on rather than staying due
    const after = await app.inject({
      method: "GET",
      url: `/api/mailouts/campaigns/${c.id}`,
      headers: { cookie },
    });
    expect(after.json().status).toBe("finished");

    await prisma.firmProfile.update({
      where: { id: 1 },
      data: { postalAddress: "1200 Main St, Suite 4, Charlotte, NC 28202" },
    });
  });
});

describe("where an unsubscribe came from", () => {
  /** The link carries the letter it came from; the token alone belongs to the client and cannot. */
  it("names the campaign a client left through", async () => {
    const c = (await makeCampaign({ startsOn: PAST, recipients: to(clientA) })).json();
    await runDueCampaigns();
    const run = await runOf(c.id, PAST);
    await settled(run.id);

    const link = /\/api\/mailouts\/unsubscribe\/([\w-]+)\?m=([\w-]+)/.exec(testOutbox[0].html)!;
    expect(link[2]).toBe(run.id);

    const done = await app.inject({
      method: "POST",
      url: `/api/mailouts/unsubscribe/${link[1]}?m=${link[2]}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "List-Unsubscribe=One-Click",
    });
    expect(done.statusCode).toBe(200);

    const detail = await app.inject({
      method: "GET",
      url: `/api/mailouts/campaigns/${c.id}`,
      headers: { cookie },
    });
    expect(detail.json().optOuts).toHaveLength(1);
    expect(detail.json().optOuts[0].clientId).toBe(clientA);
    expect(detail.json().optOuts[0].periodKey).toBe(PAST);

    // and the client's own card names what prompted it
    const card = await app.inject({
      method: "GET",
      url: `/api/mailouts/clients/${clientA}`,
      headers: { cookie },
    });
    expect(card.json().subscribed).toBe(false);
    expect(card.json().unsubscribedFrom.campaignId).toBe(c.id);
    expect(card.json().unsubscribedFrom.campaignName).toBe(c.name);
  });

  /**
   * The mailout id lives in the URL, which makes it a claim rather than proof. Crediting an opt-out
   * to a campaign that never wrote to that client would be a quiet lie in a report the firm trusts.
   */
  it("ignores a source the client was never part of, and still unsubscribes them", async () => {
    const theirs = (await makeCampaign({ startsOn: PAST, recipients: to(clientA) })).json();
    const others = (await makeCampaign({ startsOn: PAST, recipients: to(clientC) })).json();
    await runDueCampaigns();
    const mine = await runOf(theirs.id, PAST);
    const notMine = await runOf(others.id, PAST);
    await settled(mine.id);
    await settled(notMine.id);

    const token = (
      await prisma.clientMailPreference.findUniqueOrThrow({
        where: { clientId: clientA },
      })
    ).token;

    const done = await app.inject({
      method: "POST",
      url: `/api/mailouts/unsubscribe/${token}?m=${notMine.id}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "List-Unsubscribe=One-Click",
    });
    expect(done.statusCode).toBe(200);

    // the opt-out itself is never at the mercy of the provenance
    const pref = await prisma.clientMailPreference.findUniqueOrThrow({
      where: { clientId: clientA },
    });
    expect(pref.unsubscribedAt).not.toBeNull();
    expect(pref.unsubscribedFromMailoutId).toBeNull();

    const other = await app.inject({
      method: "GET",
      url: `/api/mailouts/campaigns/${others.id}`,
      headers: { cookie },
    });
    expect(other.json().optOuts).toHaveLength(0);
  });

  it("clears the source when the firm re-subscribes them", async () => {
    const c = (await makeCampaign({ startsOn: PAST, recipients: to(clientA) })).json();
    await runDueCampaigns();
    const run = await runOf(c.id, PAST);
    await settled(run.id);
    const token = (
      await prisma.clientMailPreference.findUniqueOrThrow({
        where: { clientId: clientA },
      })
    ).token;
    await app.inject({
      method: "POST",
      url: `/api/mailouts/unsubscribe/${token}?m=${run.id}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "List-Unsubscribe=One-Click",
    });

    await app.inject({
      method: "PATCH",
      url: `/api/mailouts/clients/${clientA}/subscription`,
      headers: { cookie },
      payload: { subscribed: true },
    });
    const pref = await prisma.clientMailPreference.findUniqueOrThrow({
      where: { clientId: clientA },
    });
    expect(pref.unsubscribedFromMailoutId).toBeNull();
  });
});

describe("the client card", () => {
  it("shows what is about to be sent to them, not only what already was", async () => {
    const c = (
      await makeCampaign({ startsOn: FUTURE, rhythm: "monthly", recipients: to(clientA) })
    ).json();

    const card = await app.inject({
      method: "GET",
      url: `/api/mailouts/clients/${clientA}`,
      headers: { cookie },
    });
    const mine = card.json().campaigns;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      id: c.id,
      name: c.name,
      rhythm: "monthly",
      status: "scheduled",
      nextRunOn: FUTURE,
      companyId: null,
      blockedReason: null,
    });
  });

  it("says on the card when a queued campaign would skip them", async () => {
    await makeCampaign({ startsOn: FUTURE, recipients: to(clientB) });
    const card = await app.inject({
      method: "GET",
      url: `/api/mailouts/clients/${clientB}`,
      headers: { cookie },
    });
    expect(card.json().campaigns[0].blockedReason).toMatch(/no email/i);
  });
});

describe("deleting", () => {
  it("refuses once anything has gone out, because those letters point back at it", async () => {
    const c = (await makeCampaign({ startsOn: PAST })).json();
    await runDueCampaigns();

    const res = await app.inject({
      method: "DELETE",
      url: `/api/mailouts/campaigns/${c.id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/already sent/i);
  });

  /**
   * `Campaign.templateId` is RESTRICT, so the database refuses this either way — without the
   * service's own count the firm gets a 500 and no idea what is holding the template, which is a
   * worse answer than "no" delivered plainly.
   */
  it("refuses to delete a template a campaign is scheduled to send", async () => {
    const t = await prisma.emailTemplate.create({
      data: { name: "Booked", subject: "s", body: "b", kind: "commercial", active: true },
    });
    await makeCampaign({ templateId: t.id, startsOn: FUTURE });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/mailouts/templates/${t.id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/scheduled by 1 campaign/i);

    await prisma.campaign.deleteMany();
    await prisma.emailTemplate.delete({ where: { id: t.id } });
  });

  it("allows it while nothing has", async () => {
    const c = (await makeCampaign({ startsOn: FUTURE })).json();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/mailouts/campaigns/${c.id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(204);
  });
});
