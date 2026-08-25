import { describe, expect, it } from "vitest";
import { SETTLE_MINUTES, deliveryState } from "./delivery.js";

const T0 = Date.parse("2026-08-25T12:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const SETTLED = SETTLE_MINUTES + 1;

/**
 * "Delivered" is the only claim here that no mail system ever makes for us. It is derived from
 * SILENCE, and silence is evidence only when somebody was listening — so every case below is
 * really asking the same question: had anyone looked, and had enough time passed?
 */
describe("what to tell somebody about one letter", () => {
  it("answers the plain cases without reference to a clock", () => {
    const base = { sentAt: null, mailboxCheckedAt: null };
    expect(deliveryState({ ...base, status: "queued" })).toBe("sending");
    expect(deliveryState({ ...base, status: "skipped" })).toBe("skipped");
    expect(deliveryState({ ...base, status: "failed" })).toBe("not_sent");
    expect(deliveryState({ ...base, status: "bounced" })).toBe("not_delivered");
  });

  /**
   * The mistake worth designing out. A mailbox nobody reads produces exactly the same silence as
   * one where every letter arrived — so calling those letters delivered would be a confident lie
   * told on the strength of nothing.
   */
  it("never claims delivery for a mailbox nobody reads", () => {
    expect(
      deliveryState(
        { status: "sent", sentAt: at(0), mailboxCheckedAt: null },
        T0 + SETTLED * 60_000,
      ),
    ).toBe("sent");
  });

  it("waits for the mail system to have had its say", () => {
    const facts = { status: "sent" as const, sentAt: at(0), mailboxCheckedAt: at(SETTLED) };
    // Read after the window, but asked about too early: still unresolved.
    expect(deliveryState(facts, T0 + 5 * 60_000)).toBe("sent");
    expect(deliveryState(facts, T0 + SETTLED * 60_000)).toBe("delivered");
  });

  /**
   * A stale reader is the subtler trap: the window passes on the wall clock while the poller has
   * been failing for a day. Time alone must never be enough.
   */
  it("will not call a letter delivered on a reader that stopped looking", () => {
    expect(
      deliveryState(
        { status: "sent", sentAt: at(0), mailboxCheckedAt: at(-10) },
        T0 + 10 * 24 * 60 * 60_000,
      ),
    ).toBe("sent");
  });

  it("needs the look to come after the window, not merely after the send", () => {
    expect(
      deliveryState(
        { status: "sent", sentAt: at(0), mailboxCheckedAt: at(SETTLE_MINUTES - 5) },
        T0 + SETTLED * 60_000,
      ),
    ).toBe("sent");
  });
});
