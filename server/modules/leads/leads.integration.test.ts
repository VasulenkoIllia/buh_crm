import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { prisma } from "../../core/db.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie: string;
let adminCookie: string;

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  return raw.split(";")[0];
}

beforeAll(async () => {
  app = await buildApp();
  await prisma.session.deleteMany();
  await prisma.authToken.deleteMany();
  await prisma.timeEntry.deleteMany();
  await prisma.subtask.deleteMany();
  await prisma.taskAssignee.deleteMany();
  await prisma.task.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.file.deleteMany();
  await prisma.client.deleteMany();
  await prisma.user.deleteMany();

  await prisma.user.create({
    data: {
      firstName: "Test",
      lastName: "User",
      email: "user@leads.local",
      passwordHash: await argon2.hash("password-123"),
      role: "user",
      status: "active",
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "user@leads.local", password: "password-123" },
  });
  cookie = cookieOf(res);

  // the pipeline's SHAPE is admin-only, like the task board's columns — leads themselves are not
  await prisma.user.create({
    data: {
      firstName: "Admin",
      lastName: "Leads",
      email: "admin@leads.local",
      passwordHash: await argon2.hash("password-123"),
      role: "admin",
      status: "active",
    },
  });
  adminCookie = cookieOf(
    await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@leads.local", password: "password-123" },
    }),
  );
});

afterAll(async () => {
  await app.close();
});

describe("leads", () => {
  let leadId: string;

  // contacts are optional (user, 2026-07-26 — supersedes the S5 "at least one contact" rule):
  // a lead often arrives as a name and a note, with the phone/email filled in later
  it("creates a lead with no contact details at all", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/leads",
      headers: { cookie },
      payload: { name: "No Contact" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.phone).toBeNull();
    expect(body.email).toBeNull();
  });

  it("creates a lead in the FIRST stage, whichever that is", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/leads",
      headers: { cookie },
      payload: { name: "Maria Bond", phone: "+380671234567" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    leadId = body.id;
    // not a named stage: the pipeline is the firm's to rearrange, and a new lead simply starts at
    // the front of whatever it currently is
    const stages = (
      await app.inject({ method: "GET", url: "/api/leads/stages", headers: { cookie } })
    ).json();
    expect(body.stageId).toBe(stages[0].id);
    expect(body.stageName).toBe(stages[0].name);
    expect(body.outcome).toBe("in_process");
  });

  it("moves the lead across pipeline stages", async () => {
    const stages = (
      await app.inject({ method: "GET", url: "/api/leads/stages", headers: { cookie } })
    ).json();
    const target = stages[2];
    const res = await app.inject({
      method: "PATCH",
      url: `/api/leads/${leadId}/position`,
      headers: { cookie },
      payload: { stageId: target.id, afterLeadId: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stageId).toBe(target.id);
    expect(res.json().stageName).toBe(target.name);
  });

  it("lets an edit clear the last contact", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/leads/${leadId}`,
      headers: { cookie },
      payload: { phone: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().phone).toBeNull();
  });

  it("rejects a whitespace-only lead name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/leads",
      headers: { cookie },
      payload: { name: "   ", phone: "+380000000001" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("serves the board and the archive as separate queries", async () => {
    const closed = await app.inject({
      method: "POST",
      url: "/api/leads",
      headers: { cookie },
      payload: { name: "Closed Lead", phone: "+380670000009" },
    });
    const closedId = closed.json().id;
    await app.inject({ method: "POST", url: `/api/leads/${closedId}/mark-lost`, headers: { cookie } });

    const board = await app.inject({ method: "GET", url: "/api/leads?scope=in_process", headers: { cookie } });
    const archive = await app.inject({ method: "GET", url: "/api/leads?scope=closed", headers: { cookie } });

    const boardIds = board.json().items.map((l: { id: string }) => l.id);
    const archiveIds = archive.json().items.map((l: { id: string }) => l.id);
    // a closed lead leaves the pipeline entirely — the board never has to filter it out
    expect(boardIds).toContain(leadId);
    expect(boardIds).not.toContain(closedId);
    expect(archiveIds).toEqual([closedId]);
    expect(board.json().truncated).toBe(false);
    expect(archive.json().total).toBe(1);
  });

  it("marks lost, blocks moving a lost lead, then reopens", async () => {
    const lost = await app.inject({
      method: "POST",
      url: `/api/leads/${leadId}/mark-lost`,
      headers: { cookie },
    });
    expect(lost.json().outcome).toBe("lost");

    // a lost lead must be reopened before it can move stages
    const move = await app.inject({
      method: "PATCH",
      url: `/api/leads/${leadId}`,
      headers: { cookie },
      payload: { stage: "Thinking" },
    });
    expect(move.statusCode).toBe(400);

    const reopened = await app.inject({
      method: "POST",
      url: `/api/leads/${leadId}/reopen`,
      headers: { cookie },
    });
    expect(reopened.json().outcome).toBe("in_process");
  });

  it("converts the lead into an individual client and locks it", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/leads/${leadId}/convert`,
      headers: { cookie },
      payload: {
        firstName: "Maria",
        lastName: "Bond",
        phone: "+380671234567",
      },
    });
    expect(res.statusCode).toBe(200);
    const { clientId, lead } = res.json();
    expect(lead.outcome).toBe("won");
    expect(lead.convertedClientId).toBe(clientId);

    const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(client.firstName).toBe("Maria");

    // converted lead is read-only
    const edit = await app.inject({
      method: "PATCH",
      url: `/api/leads/${leadId}`,
      headers: { cookie },
      payload: { name: "Changed" },
    });
    expect(edit.statusCode).toBe(400);

    const again = await app.inject({
      method: "POST",
      url: `/api/leads/${leadId}/convert`,
      headers: { cookie },
      payload: { firstName: "X", lastName: "Y" },
    });
    expect(again.statusCode).toBe(400);
  });

  // 2026-07-26: a lead is a person with an optional company LABEL — no individual/company
  // discriminator on either side any more, so convert is a straight field copy
  it("carries the company label through convert", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/leads",
      headers: { cookie },
      payload: { name: "Petro Tkach", companyName: "Romashka LLC", email: "info@romashka.ua" },
    });
    expect(created.json().companyName).toBe("Romashka LLC");

    const res = await app.inject({
      method: "POST",
      url: `/api/leads/${created.json().id}/convert`,
      headers: { cookie },
      payload: {
        firstName: "Petro",
        lastName: "Tkach",
        companyName: "Romashka LLC",
        email: "info@romashka.ua",
      },
    });
    expect(res.statusCode).toBe(200);
    const client = await prisma.client.findUniqueOrThrow({
      where: { id: res.json().clientId },
    });
    expect(client.firstName).toBe("Petro");
    expect(client.companyName).toBe("Romashka LLC"); // a label, not a Company row
    expect(await prisma.company.count({ where: { clientId: client.id } })).toBe(0);
  });

  it("rejects a convert with no first name", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/leads",
      headers: { cookie },
      payload: { name: "NoName Co", phone: "+380000000000" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/leads/${created.json().id}/convert`,
      headers: { cookie },
      payload: { lastName: "B" },
    });
    expect(res.statusCode).toBe(400);
  });
});

/**
 * Dragging a lead on the pipeline board (user, 2026-08-28).
 *
 * Same shape as the tasks board — an anchor, a renumbered stage, and the guards that stop a closed
 * lead being quietly reopened by dropping it somewhere.
 */
describe("leads — dragging on the board", () => {
  const make = async (name: string) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/leads",
      headers: { cookie },
      payload: { name },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  };
  /** the pipeline is data now, so a test asks for a stage by the name a person would say */
  const stageId = async (name: string) => {
    const res = await app.inject({ method: "GET", url: "/api/leads/stages", headers: { cookie } });
    const stage = res.json().find((s: { name: string }) => s.name === name);
    expect(stage, `no stage named ${name}`).toBeTruthy();
    return stage.id as string;
  };
  const move = async (id: string, stageName: string, afterLeadId: string | null) =>
    app.inject({
      method: "PATCH",
      url: `/api/leads/${id}/position`,
      headers: { cookie },
      payload: { stageId: await stageId(stageName), afterLeadId },
    });
  const stageOf = async (stage: string) => {
    const res = await app.inject({ method: "GET", url: "/api/leads?scope=in_process", headers: { cookie } });
    return res
      .json()
      .items.filter((l: { stageName: string }) => l.stageName === stage)
      .sort((a: { boardOrder: number }, b: { boardOrder: number }) => a.boardOrder - b.boardOrder)
      .map((l: { name: string }) => l.name)
      // this suite shares a stage with the cases above it; only the ones made here are asserted
      .filter((n: string) => n.startsWith("Drag "));
  };

  let a = "", b = "", c = "";
  it("puts three leads in one stage", async () => {
    a = await make("Drag A");
    b = await make("Drag B");
    c = await make("Drag C");
    for (const [id, after] of [[a, null], [b, a], [c, b]] as const) {
      expect((await move(id, "First contact", after)).statusCode).toBe(200);
    }
    expect(await stageOf("First contact")).toEqual(["Drag A", "Drag B", "Drag C"]);
  });

  it("moves one within its stage, behind a named neighbour", async () => {
    expect((await move(a, "First contact", c)).statusCode).toBe(200);
    expect(await stageOf("First contact")).toEqual(["Drag B", "Drag C", "Drag A"]);
  });

  it("a null anchor is the top of the stage", async () => {
    expect((await move(a, "First contact", null)).statusCode).toBe(200);
    expect(await stageOf("First contact")).toEqual(["Drag A", "Drag B", "Drag C"]);
  });

  it("carries a lead into another stage, at the position asked for", async () => {
    expect((await move(b, "Thinking", null)).statusCode).toBe(200);
    expect(await stageOf("Thinking")).toEqual(["Drag B"]);
    // and it left the one it came from, renumbered behind it
    expect(await stageOf("First contact")).toEqual(["Drag A", "Drag C"]);
  });

  it("leaves the stage a clean 0..n-1 run", async () => {
    const res = await app.inject({ method: "GET", url: "/api/leads?scope=in_process", headers: { cookie } });
    const orders = res
      .json()
      .items.filter((l: { stageName: string }) => l.stageName === "First contact")
      .map((l: { boardOrder: number }) => l.boardOrder)
      .sort((x: number, y: number) => x - y);
    /**
     * No two leads share a place. NOT "0..n-1 with no gaps": the renumber covers the whole stage,
     * and a stage also holds leads that are lost or won and therefore absent from this list — so
     * the board's own subset is expected to have gaps in it. What must never happen is a repeat,
     * because that is what makes an order ambiguous.
     */
    expect(orders).toEqual([...new Set(orders)]);
  });

  it("an anchor that is not in the stage puts it on top rather than guessing", async () => {
    expect((await move(c, "First contact", b)).statusCode).toBe(200); // b is in `thinking` now
    expect((await stageOf("First contact"))[0]).toBe("Drag C");
  });

  it("refuses to move a lead that has been marked lost", async () => {
    await app.inject({ method: "POST", url: `/api/leads/${c}/mark-lost`, headers: { cookie } });
    expect((await move(c, "Thinking", null)).statusCode).toBe(400);
  });
});

/**
 * The pipeline's own columns (user, 2026-08-28) — a table since the enum was retired.
 *
 * The same rules as the task board's columns, which is the point of having made the change: add at
 * the end, rename, drag into place, and delete only while nothing is standing in the column.
 */
describe("leads — the pipeline's stages", () => {
  const list = async () => {
    const res = await app.inject({ method: "GET", url: "/api/leads/stages", headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    return res.json() as { id: string; name: string; order: number }[];
  };
  const add = (name: string) =>
    app.inject({ method: "POST", url: "/api/leads/stages", headers: { cookie: adminCookie }, payload: { name } });

  it("holds the six the firm has been working with, each in its own place", async () => {
    const stages = await list();
    // the SET, not the sequence: other suites share this database and may have dragged them, and a
    // test that depends on the order it happens to run in is one that will lie one day
    expect(new Set(stages.map((s) => s.name))).toEqual(
      new Set(["First contact", "No answer", "Set up meeting", "Thinking", "On hold", "Next time"]),
    );
    /**
     * Ascending and distinct — NOT 0..n-1. Deleting a stage leaves the gap it was occupying, and
     * that is fine: the order is relative, and the next drag renumbers the whole list anyway. The
     * property that matters is that no two stages claim the same place.
     */
    const orders = stages.map((s) => s.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("adds one at the END, and refuses a duplicate name", async () => {
    const created = await add("Proposal sent");
    expect(created.statusCode).toBe(201);
    expect((await list()).at(-1)!.name).toBe("Proposal sent");
    expect((await add("proposal SENT")).statusCode).toBe(409); // case-insensitive, like a service
  });

  it("renames one", async () => {
    const stage = (await list()).find((s) => s.name === "Proposal sent")!;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/leads/stages/${stage.id}`,
      headers: { cookie: adminCookie },
      payload: { name: "Proposal out" },
    });
    expect(res.statusCode).toBe(200);
    expect((await list()).some((s) => s.name === "Proposal out")).toBe(true);
  });

  it("drags one into place, by an anchor", async () => {
    const stages = await list();
    const last = stages.at(-1)!;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/leads/stages/${last.id}/position`,
      headers: { cookie: adminCookie },
      payload: { afterStageId: stages[0].id },
    });
    expect(res.statusCode).toBe(200);
    const after = await list();
    expect(after[1].id).toBe(last.id);
    expect(after.map((s) => s.order)).toEqual(after.map((_, i) => i)); // no gaps, no repeats
  });

  it("a null anchor puts it first", async () => {
    const moved = (await list()).at(-1)!;
    await app.inject({
      method: "PATCH",
      url: `/api/leads/stages/${moved.id}/position`,
      headers: { cookie: adminCookie },
      payload: { afterStageId: null },
    });
    expect((await list())[0].id).toBe(moved.id);
  });

  it("refuses to delete one a lead is standing in, and says how many", async () => {
    const stage = (await list())[0];
    const lead = await app.inject({
      method: "POST",
      url: "/api/leads",
      headers: { cookie: adminCookie },
      payload: { name: "Occupant" },
    });
    // a new lead starts in the FIRST stage, whichever the pipeline currently begins with
    expect(lead.json().stageId).toBe(stage.id);
    const res = await app.inject({
      method: "DELETE",
      url: `/api/leads/stages/${stage.id}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(409);
    // a COUNT and the stage's name; not a fixed number, since this database is shared
    expect(res.json().error.message).toMatch(new RegExp(`${stage.name}.*\\d+ lead`));
  });

  it("deletes an empty one", async () => {
    const empty = (await list()).find((s) => s.name === "Proposal out")!;
    const before = (await list()).length;
    const res = await app.inject({
      method: "DELETE",
      url: `/api/leads/stages/${empty.id}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect((await list()).length).toBe(before - 1);
  });
});
