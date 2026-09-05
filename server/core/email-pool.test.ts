import { describe, expect, it } from "vitest";
import { buildTransportForTest } from "./email.js";

/**
 * Every letter must not open its own connection.
 *
 * Without `pool: true` nodemailer opens one per message and closes it: a hundred-recipient mailout
 * is a hundred handshakes, and the notification path is worse — `notify()` fires a DETACHED send
 * per recipient, so a morning raising forty overdue tasks opened roughly forty connections at
 * once. Against Mailpit that is invisible; against a real provider it is what rate-limiters exist
 * for, and because every send is `void`ed the failure would have looked exactly like success from
 * inside the app (audit, 2026-09-06).
 *
 * Asserted through nodemailer's own shape rather than by reading our options back: `SMTPPool` and
 * `SMTPTransport` are different classes, so this fails if somebody removes the flag rather than
 * merely renaming a constant.
 */
describe("outgoing mail is pooled and paced", () => {
  const account = { host: "localhost", port: 1025, secure: false, user: null, pass: null };

  it("uses a pool, not a connection per message", () => {
    const transport = buildTransportForTest(account);
    try {
      expect(transport.transporter.constructor.name).toBe("SMTPPool");
    } finally {
      transport.close();
    }
  });

  it("bounds how many connections and how fast", () => {
    const transport = buildTransportForTest(account);
    try {
      const options = transport.transporter.options as {
        maxConnections?: number;
        maxMessages?: number;
        rateLimit?: number;
        rateDelta?: number;
      };
      // the numbers may be tuned for a provider; that they EXIST is the guarantee
      expect(options.maxConnections, "a ceiling on concurrent connections").toBeGreaterThan(0);
      expect(
        options.maxMessages,
        "reconnect before a server caps the session for us",
      ).toBeGreaterThan(0);
      expect(options.rateLimit, "a burst is what trips a provider's limiter").toBeGreaterThan(
        0,
      );
      expect(options.rateDelta).toBeGreaterThan(0);
    } finally {
      transport.close();
    }
  });
});
