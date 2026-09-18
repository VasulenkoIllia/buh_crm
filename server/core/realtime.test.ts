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

  it("refuses a payload over what a notification may carry", async () => {
    const crowd = Array.from({ length: 250 }, () => randomUUID());
    await expect(publish(crowd, "pong", { pingId: randomUUID() })).rejects.toThrow(
      /over the 7900/,
    );
  });

  it("checks the payload even when nobody is named, and then sends nothing", async () => {
    await expect(publish([], "pong", { pingId: "a client's name" })).rejects.toThrow(
      RealtimePayloadError,
    );
    await expect(publish([], "pong", { pingId: randomUUID() })).resolves.toBeUndefined();
  });
});
