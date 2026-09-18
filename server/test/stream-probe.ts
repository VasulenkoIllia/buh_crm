import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";

/**
 * **A Server-Sent Events client for the suite, over a real socket** (chat.md §7.4).
 *
 * `app.inject` resolves when a response ENDS, and a stream the caller is allowed into does not, so
 * a suite that injects a stream route waits for ever. This listens on a free port once per app and
 * opens a genuine HTTP request: a refusal comes back as an ordinary finished response with its JSON
 * body, and an accepted stream as a live one whose events can be awaited one at a time.
 */

export interface StreamEvent {
  event: string;
  data: unknown;
}

export interface TestStream {
  status: number;
  headers: IncomingHttpHeaders;
  /** a refusal's parsed JSON body; `null` for an accepted stream */
  body: unknown;
  /** everything received so far, exactly as it came off the wire */
  raw(): string;
  /** the next event with this name (any name when omitted); rejects after `timeoutMs` */
  next(event?: string, timeoutMs?: number): Promise<StreamEvent>;
  /** resolves once the server has ended the response */
  ended: Promise<void>;
  close(): void;
}

async function baseUrl(app: FastifyInstance): Promise<string> {
  if (!app.server.listening) await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function parseBlock(block: string): StreamEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue; // a comment: the heartbeat
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }
  if (data.length === 0) return null; // `retry:` alone, or a comment
  return { event, data: JSON.parse(data.join("\n")) as unknown };
}

export async function openTestStream(
  app: FastifyInstance,
  url: string,
  headers: Record<string, string> = {},
): Promise<TestStream> {
  const target = new URL(url, await baseUrl(app));
  return new Promise((resolve, reject) => {
    const req = httpRequest(target, { method: "GET", headers }, (res) => {
      let raw = "";
      let pending = "";
      const queue: StreamEvent[] = [];
      // every `next()` still waiting, so two awaited at once on one stream both hear their event
      const waiters = new Set<() => void>();
      const wake = () => {
        for (const waiter of [...waiters]) waiter();
      };
      let endedResolve!: () => void;
      const ended = new Promise<void>((r) => (endedResolve = r));

      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        raw += chunk;
        pending += chunk;
        let cut: number;
        while ((cut = pending.indexOf("\n\n")) !== -1) {
          const parsed = parseBlock(pending.slice(0, cut));
          pending = pending.slice(cut + 2);
          if (parsed) queue.push(parsed);
        }
        wake();
      });
      res.on("end", () => endedResolve());
      res.on("close", () => {
        endedResolve();
        wake();
      });

      const isStream = String(res.headers["content-type"] ?? "").startsWith(
        "text/event-stream",
      );

      const next = (event?: string, timeoutMs = 2_000) =>
        new Promise<StreamEvent>((ok, fail) => {
          const timer = setTimeout(() => {
            waiters.delete(look);
            fail(new Error(`no "${event ?? "any"}" event within ${timeoutMs} ms; got: ${raw}`));
          }, timeoutMs);
          function look() {
            const at = queue.findIndex((e) => !event || e.event === event);
            if (at === -1) return;
            clearTimeout(timer);
            waiters.delete(look);
            ok(queue.splice(at, 1)[0]);
          }
          waiters.add(look);
          look();
        });

      const handle = (body: unknown): TestStream => ({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body,
        raw: () => raw,
        next,
        ended,
        close: () => req.destroy(),
      });

      if (isStream) {
        resolve(handle(null));
        return;
      }
      // a refusal: read it to the end and hand back its JSON
      const parsed = (): unknown => {
        try {
          return raw ? JSON.parse(raw) : null;
        } catch {
          return raw;
        }
      };
      ended.then(() => resolve(handle(parsed())), reject);
    });
    req.on("error", reject);
    req.end();
  });
}
