/**
 * Live probing against a REAL SMTP server (Mailpit) — the things a unit test cannot see:
 * what actually goes on the wire, and how long the sweep takes on a realistic number of rows.
 *
 * DEV ONLY. Creates users under @probe.local and removes them again.
 */
import { prisma } from "../../server/core/db.js";
import { notify } from "../../server/core/notify.js";
import argon2 from "argon2";
import { refuseOnProduction } from "./guard.js";

refuseOnProduction("scripts/dev/probe-notifications.ts");

const MAILPIT = "http://localhost:8025";

async function inbox() {
  const r = await fetch(`${MAILPIT}/api/v1/messages?limit=50`);
  return (await r.json()) as {
    total: number;
    messages: Array<{ ID: string; Subject: string }>;
  };
}
async function raw(id: string) {
  return (await fetch(`${MAILPIT}/api/v1/message/${id}/raw`)).text();
}
async function clearInbox() {
  await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });
}

const hash = await argon2.hash("password-123");
const mk = async (first: string, over: Record<string, unknown> = {}) =>
  prisma.user.upsert({
    where: { email: `${first}@probe.local` },
    update: { status: "active", ...over },
    create: {
      firstName: first,
      lastName: "Probe",
      email: `${first}@probe.local`,
      passwordHash: hash,
      role: "user",
      status: "active",
      ...over,
    },
  });

async function taskFor(title: string, userIds: string[]) {
  const priority = await prisma.priority.findFirstOrThrow({ where: { isDefault: true } });
  const column = await prisma.taskColumn.findFirstOrThrow({ where: { isFixed: true } });
  const t = await prisma.task.create({
    data: {
      title: `[probe] ${title}`,
      kind: "free",
      priorityId: priority.id,
      statusColumnId: column.id,
    },
  });
  for (const userId of userIds)
    await prisma.taskAssignee.create({ data: { taskId: t.id, userId } });
  return t;
}

const findings: string[] = [];
const ok = (s: string) => console.log(`  OK    ${s}`);
const bad = (s: string) => {
  console.log(`  ISSUE ${s}`);
  findings.push(s);
};

async function main() {
  const probe = await mk("probe");
  await prisma.notificationPolicy.update({
    where: { trigger: "task_assigned" },
    data: { enabled: true, inApp: true, email: true, defaultInApp: true, defaultEmail: true },
  });

  // ── A. header injection through a task title ──────────────────────────────
  console.log("\nA. a newline in a task title reaches the mail SUBJECT");
  await clearInbox();
  const evilTitle = "Innocent\r\nBcc: attacker@evil.example";
  const t1 = await taskFor("hdr", [probe.id]);
  await notify("task_assigned", {
    dedup: `hdr-${Date.now()}`,
    taskId: t1.id,
    vars: { actor: "Olena", task: evilTitle },
    link: { type: "task", id: t1.id },
  });
  await new Promise((r) => setTimeout(r, 800));
  const box1 = await inbox();
  if (box1.total === 0) {
    bad("no letter arrived at all");
  } else {
    const src = await raw(box1.messages[0].ID);
    const headerBlock = src.split(/\r?\n\r?\n/)[0];
    const bccLine = headerBlock.split(/\r?\n/).find((l) => /^Bcc:/i.test(l));
    if (bccLine) bad(`HEADER INJECTION: a task title created a real header -> ${bccLine}`);
    else ok("nodemailer folded/encoded it — no injected Bcc header on the wire");
    const recipients = (src.match(/^To:.*$/im) ?? [""])[0];
    if (/attacker@evil/.test(recipients)) bad(`the attacker address reached To: ${recipients}`);
    else ok("the attacker address is not in To:");
  }

  // ── B. HTML injection into the letter body ────────────────────────────────
  console.log("\nB. markup in a task title");
  await clearInbox();
  const t2 = await taskFor("xss", [probe.id]);
  await notify("task_assigned", {
    dedup: `xss-${Date.now()}`,
    taskId: t2.id,
    vars: { actor: "Olena", task: `<img src=x onerror=alert(1)>` },
    sub: `<script>alert(2)</script>`,
    link: { type: "task", id: t2.id },
  });
  await new Promise((r) => setTimeout(r, 800));
  const box2 = await inbox();
  /**
   * The HTML part as MAILPIT decodes it, not as a regex over raw MIME guesses at it.
   *
   * The first version of this probe split the raw source on `Content-Transfer-Encoding: base64`
   * and fell back to the WHOLE message when that failed — so it was matching against the
   * text/plain part, where the title is supposed to be literal. It reported two injections that
   * do not exist. A probe that cries wolf is worse than no probe, and this comment is here so
   * nobody re-introduces the shortcut.
   */
  const decoded = (await (
    await fetch(`${MAILPIT}/api/v1/message/${box2.messages[0].ID}`)
  ).json()) as { HTML: string; Text: string };
  if (/<img src=x onerror/.test(decoded.HTML))
    bad("the raw <img onerror> survived into the letter html");
  else ok("<img onerror> is escaped in the html part");
  if (/<script>alert\(2\)/.test(decoded.HTML))
    bad("a <script> tag from `sub` survived into the letter html");
  else ok("<script> from the second line is escaped too");
  if (!/&lt;img src=x/.test(decoded.HTML))
    bad("the escaped form is missing — is the title reaching the letter at all?");
  else ok("it arrives escaped, so the reader sees it as text");
  if (!/<img src=x onerror/.test(decoded.Text)) bad("the text/plain part lost the title");
  else ok("text/plain carries it literally, which is correct for a text part");

  // ── C. two people, two settings, one event, over real SMTP ────────────────
  console.log("\nC. one event, different settings per person");
  await clearInbox();
  const wantsAll = await mk("wantsall");
  const bellOnly = await mk("bellonly");
  const silent = await mk("silent");
  const blocked = await mk("blockedone", { status: "blocked" });
  await prisma.notificationPreference.deleteMany({
    where: { userId: { in: [wantsAll.id, bellOnly.id, silent.id] } },
  });
  await prisma.notificationPreference.createMany({
    data: [
      { userId: bellOnly.id, trigger: "task_assigned", channel: "email", enabled: false },
      { userId: silent.id, trigger: "task_assigned", channel: "in_app", enabled: false },
      { userId: silent.id, trigger: "task_assigned", channel: "email", enabled: false },
    ],
  });
  const t3 = await taskFor("shared", [wantsAll.id, bellOnly.id, silent.id, blocked.id]);
  await notify("task_assigned", {
    dedup: `shared-${Date.now()}`,
    taskId: t3.id,
    vars: { actor: "Olena", task: "Shared work" },
    link: { type: "task", id: t3.id },
  });
  await new Promise((r) => setTimeout(r, 1200));
  const box3 = await inbox();
  const to = new Set<string>();
  for (const m of box3.messages) {
    const s = await raw(m.ID);
    for (const line of s.split(/\r?\n/)) if (/^To:/i.test(line)) to.add(line.slice(3).trim());
  }
  const has = (e: string) => [...to].some((x) => x.includes(e));
  if (has("wantsall@probe.local")) ok("the person on defaults got the letter");
  else bad("defaults produced no letter");
  if (!has("bellonly@probe.local")) ok("email=off produced no letter");
  else bad("email=off still got a letter");
  if (!has("silent@probe.local")) ok("both-off produced no letter");
  else bad("both-off still got a letter");
  if (!has("blockedone@probe.local")) ok("a blocked user got no letter");
  else bad("a BLOCKED user was mailed");

  const trayOf = async (id: string) =>
    prisma.notification.count({ where: { userId: id, readAt: null } });
  if ((await trayOf(wantsAll.id)) === 1) ok("defaults: one unread row");
  else bad("defaults: wrong unread count");
  if ((await trayOf(bellOnly.id)) === 1) ok("email=off: still in the tray");
  else bad("email=off: not in the tray");
  if ((await trayOf(silent.id)) === 0) ok("both-off: nothing in the tray");
  else bad("both-off: a row appeared");
  if ((await prisma.notification.count({ where: { userId: blocked.id } })) === 0)
    ok("a blocked user has no row at all");
  else bad("a blocked user got a row");

  // ── D. how long does the sweep take with real volume ──────────────────────
  console.log("\nD. sweep cost per notification");
  const started = Date.now();
  const many = await Promise.all(
    Array.from({ length: 40 }, (_, i) => taskFor(`bulk ${i}`, [probe.id])),
  );
  let n = 0;
  const t0 = Date.now();
  for (const t of many) {
    n += (
      await notify("task_overdue", {
        dedup: t.id,
        taskId: t.id,
        vars: { task: t.title },
        link: { type: "task", id: t.id },
      })
    ).written;
  }
  const per = (Date.now() - t0) / Math.max(n, 1);
  console.log(
    `  ${n} notifications in ${Date.now() - t0}ms (${per.toFixed(1)}ms each, setup ${t0 - started}ms)`,
  );
  if (per > 60)
    bad(
      `each notification costs ${per.toFixed(0)}ms — a 500-row sweep would take ${((per * 500) / 1000).toFixed(0)}s`,
    );
  else ok(`${per.toFixed(1)}ms per notification is fine for a nightly sweep`);

  // a second pass must be nearly free AND silent
  const t1b = Date.now();
  let again = 0;
  for (const t of many) {
    again += (
      await notify("task_overdue", {
        dedup: t.id,
        taskId: t.id,
        vars: { task: t.title },
        link: { type: "task", id: t.id },
      })
    ).written;
  }
  if (again === 0) ok(`re-run wrote nothing (${Date.now() - t1b}ms for 40 checks)`);
  else bad(`re-run wrote ${again} rows`);

  // ── cleanup ───────────────────────────────────────────────────────────────
  const probeIds = (
    await prisma.user.findMany({
      where: { email: { endsWith: "@probe.local" } },
      select: { id: true },
    })
  ).map((u) => u.id);
  const probeTasks = (
    await prisma.task.findMany({
      where: { title: { startsWith: "[probe]" } },
      select: { id: true },
    })
  ).map((t) => t.id);
  await prisma.notification.deleteMany({ where: { userId: { in: probeIds } } });
  await prisma.notificationPreference.deleteMany({ where: { userId: { in: probeIds } } });
  await prisma.taskAssignee.deleteMany({ where: { taskId: { in: probeTasks } } });
  await prisma.task.deleteMany({ where: { id: { in: probeTasks } } });
  await prisma.user.deleteMany({ where: { id: { in: probeIds } } });
  await clearInbox();

  console.log(
    `\n${findings.length === 0 ? "no issues found" : `${findings.length} ISSUE(S):`}`,
  );
  for (const f of findings) console.log(`  - ${f}`);
}

await main();
await prisma.$disconnect();
