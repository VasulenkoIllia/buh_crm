import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { publish, RealtimePayloadError } from "./realtime.js";

/**
 * **A notification carries ids, numbers and short tokens, never anything a person wrote**
 * (chat.md §7.1, §19 "NOTIFY payloads hold no text"). Refused before anything reaches the database,
 * so these need none.
 */
describe("what publish() refuses", () => {
  const someone = randomUUID();

  it("refuses text where an id belongs", async () => {
    await expect(
      publish([someone], "pong", { pingId: "Petrenko's 1040 is ready" }),
    ).rejects.toThrow(RealtimePayloadError);
  });

  it("refuses a recipient that is not a user id", async () => {
    await expect(publish(["olena"], "pong", { pingId: randomUUID() })).rejects.toThrow(
      RealtimePayloadError,
    );
  });

  /**
   * This asked the opposite until 2026-09-20, and the opposite was a bug: a crowd made the payload
   * too long and the WHOLE event was dropped with one line in the log. The announcements channel
   * holds every person in the firm, so past ~200 colleagues no announcement reached any open tab
   * (audit). The recipients go in bites now; what is still refused is an event whose own DATA is
   * too large, which no producer can reach and which would mean a rule was broken elsewhere.
   */
  it("sends to a crowd larger than one notification can name", async () => {
    const crowd = Array.from({ length: 250 }, () => randomUUID());
    await expect(publish(crowd, "pong", { pingId: randomUUID() })).resolves.toBeUndefined();
  });

  it("checks the payload even when nobody is named, and then sends nothing", async () => {
    await expect(publish([], "pong", { pingId: "a client's name" })).rejects.toThrow(
      RealtimePayloadError,
    );
    await expect(publish([], "pong", { pingId: randomUUID() })).resolves.toBeUndefined();
  });
});
