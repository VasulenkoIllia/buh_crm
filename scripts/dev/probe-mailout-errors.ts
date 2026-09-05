/**
 * The sixteenth trigger, `ops_mailout_errors`, end to end against a real (broken) SMTP host.
 *
 * It is the one trigger the other probes leave alone, because raising it for real means a mailout
 * run that FAILS — which writes rows into the client mail log, and that log is the firm's record
 * of what it sent to whom. So this builds its own throwaway world: its own client, its own sender
 * mailbox pointed at an address that drops packets, and it removes both afterwards. The firm's
 * default mailbox is never touched.
 *
 * DEV ONLY.
 */
import { prisma } from "../../server/core/db.js";
import { send } from "../../server/modules/mailouts/mailouts.service.js";

const findings: string[] = [];
const ok = (s: string) => console.log(`  OK    ${s}`);
const bad = (s: string) => {
  console.log(`  ISSUE ${s}`);
  findings.push(s);
};

async function main() {
  const sender = await prisma.user.findUniqueOrThrow({
    where: { email: "olena@buh-crm.local" },
  });
  const before = await prisma.notification.count({
    where: { userId: sender.id, trigger: "ops_mailout_errors" },
  });

  const client = await prisma.client.create({
    data: {
      firstName: "[probe] Mailout",
      lastName: "Failure",
      email: "nobody@probe.invalid",
    },
  });
  const mailbox = await prisma.mailSenderAccount.create({
    data: {
      name: "[probe] broken mailbox",
      fromName: "Probe",
      fromEmail: "probe@buh-crm.local",
      // an address that DROPS packets — the failure mode that hangs rather than refusing
      smtpHost: "10.255.255.1",
      smtpPort: 587,
      smtpSecure: false,
      active: true,
    },
  });

  try {
    console.log("\nsending a transactional letter from a mailbox that cannot connect…");
    const t0 = Date.now();
    const res = await send(sender, {
      letter: {
        subject: "[probe] a letter that cannot be delivered",
        heading: null,
        body: "This exists only to make the delivery run fail.",
        kind: "transactional",
      },
      recipients: [{ clientId: client.id, companyId: null }],
      senderAccountId: mailbox.id,
    });
    console.log(
      `  send() returned in ${((Date.now() - t0) / 1000).toFixed(1)}s (delivery runs after)`,
    );
    if (Date.now() - t0 > 5000) {
      bad(`send() blocked the caller for ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    } else {
      ok("send() returns immediately — delivery is detached, as designed");
    }

    // the run closes in the background; wait for the recipient row to stop being `queued`
    let rows: Array<{ status: string; reason: string | null }> = [];
    for (let i = 0; i < 240; i++) {
      rows = await prisma.mailoutRecipient.findMany({ where: { mailoutId: res.id } });
      if (rows.length && !rows.some((r) => r.status === "queued")) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (rows.every((r) => r.status === "failed")) {
      ok(`every recipient closed as failed: ${JSON.stringify(rows[0].reason)}`);
    } else {
      bad(
        `recipients did not all close as failed: ${JSON.stringify(rows.map((r) => r.status))}`,
      );
    }

    let raised: { text: string; sub: string | null; linkType: string | null } | null = null;
    for (let i = 0; i < 80; i++) {
      raised = await prisma.notification.findFirst({
        where: { userId: sender.id, dedupKey: `ops_mailout_errors:${res.id}` },
        select: { text: true, sub: true, linkType: true },
      });
      if (raised) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!raised) bad("the sender was never told the run failed");
    else {
      ok(`the SENDER was told: "${raised.text}"`);
      if (raised.linkType === "mailout") ok("and it links back to the mailouts screen");
      else bad(`it links to ${raised.linkType}, not the mailout`);
    }

    const after = await prisma.notification.count({
      where: { userId: sender.id, trigger: "ops_mailout_errors" },
    });
    if (after === before + 1) ok("exactly one notification for the run");
    else bad(`${after - before} notifications for one run`);

    // ── cleanup ─────────────────────────────────────────────────────────────
    await prisma.notification.deleteMany({
      where: { dedupKey: `ops_mailout_errors:${res.id}` },
    });
    await prisma.mailoutRecipient.deleteMany({ where: { mailoutId: res.id } });
    await prisma.mailout.deleteMany({ where: { id: res.id } });
  } finally {
    await prisma.clientMailPreference.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
    await prisma.mailSenderAccount.delete({ where: { id: mailbox.id } });
    const left = await prisma.mailSenderAccount.count({
      where: { name: { startsWith: "[probe]" } },
    });
    if (left === 0)
      ok("the throwaway mailbox and client are gone; the firm's default was never touched");
    else bad("a probe mailbox was left behind");
  }

  console.log(
    `\n${findings.length === 0 ? "no issues found" : `${findings.length} FINDING(S):`}`,
  );
  for (const f of findings) console.log(`  - ${f}`);
}

await main();
await prisma.$disconnect();
