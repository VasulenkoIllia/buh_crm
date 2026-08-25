# Real bounces, sanitised

Six delivery-status notifications from production, 19–25 Aug 2026. They exist because an **invented**
fixture agrees with whatever rule you invented alongside it, and these did not: the Yahoo one is a
dead mailbox reported as `552` with **no enhanced status code at all**, which the first draft of the
classifier would have filed as "the letter was too large" — never blacklisting an address that is
gone. Only real samples show that.

| File                                       | Stage         | Code                      | Truth                    |
| ------------------------------------------ | ------------- | ------------------------- | ------------------------ |
| `gmail-550-5.1.1-no-such-user` / `-repeat` | `RCPT TO`     | 550 5.1.1                 | mailbox gone             |
| `google-550-5.1.1-no-such-user`            | `RCPT TO`     | 550 5.1.1                 | mailbox gone             |
| `yahoo-552-no-enhanced-code`               | `end of data` | 552, **no enhanced code** | mailbox gone             |
| `ukrnet-554-5.3.0-helo` / `-repeat`        | `HELO`        | 554 5.3.0                 | our own relay's greeting |

`Status:` is `5.0.0` in all six — Exim's generic "permanent", carrying nothing. The reason lives in
`Diagnostic-Code:`, and the enhanced code inside it is **optional**.

## What was changed, and what was not

This repository is public, so every identity is replaced: real recipients, the firm's mailbox, the
relay hostname, the CRM host and its IP. **Unsubscribe tokens are stripped** — they are live and
would let anyone opt a real client out. The returned letter's **body is dropped entirely**; its
headers are kept, because `References:` quoting the original `Message-ID` is precisely the thing
these fixtures are here to prove.

Structure is otherwise byte-exact — boundaries, folding, header order, the duplicated tail in the
ukr.net diagnostic. Do not tidy it: the awkwardness is the test.

**Never add a raw production bounce here.** Sanitise identities and strip tokens first, and check
the result before staging it.
