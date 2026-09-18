import { useEffect, useState } from "react";
import type { ChatPingResult } from "@shared/schema/chat";
import { plural } from "@shared/text";
import { useCanOpen } from "@/app/auth";
import { reconnectRealtime, useChatPresence, useRealtime } from "@/modules/chat";
import { api } from "@/shared/lib/api";
import { cn } from "@/shared/lib/cn";
import { JOB_TONE_COLORS } from "@/shared/lib/colors";
import { realtime, type RealtimeSnapshot, type StopReason } from "@/shared/lib/realtime";
import { Button } from "@/shared/ui/button";

/**
 * **Settings → System → Live connection** (chat.md §15.1, step 0.4): is the chat's live connection
 * working from this computer, through Cloudflare and Traefik, and how fast.
 *
 * It is how stage 0 is verified on production (the owner leaves it open for 30 minutes, then tests
 * a delivery and a dropped network), and afterwards it stays as the first place to look when
 * somebody says a message arrived late. It holds the same one connection the chat will.
 */
export function LiveConnectionPanel() {
  const canOpen = useCanOpen("chat");
  return (
    <section>
      <h3 className="mb-2 text-[12px] font-bold text-ink-700 uppercase">Live connection</h3>
      <div className="overflow-hidden rounded-(--radius-panel) border border-border bg-surface shadow-(--shadow-card)">
        {canOpen ? (
          <LiveConnection />
        ) : (
          <p className="px-3.5 py-3 text-[12px] text-muted">Chat is closed for your account.</p>
        )}
      </div>
    </section>
  );
}

const STOPPED: Record<StopReason, string> = {
  too_many_streams: "Stopped: more than 10 CRM tabs are open.",
  session_ended: "Stopped: the session ended.",
  gate_closed: "Stopped: Chat was closed for this account.",
  two_factor_required: "Stopped: two-factor sign-in is required.",
  signed_out: "Stopped: signed out.",
  refused: "Stopped: the server refused the connection.",
};

function statusOf(snapshot: RealtimeSnapshot): { text: string; tone: "ok" | "warn" | "bad" } {
  switch (snapshot.status) {
    case "open":
      return { text: "Connected", tone: "ok" };
    case "connecting":
      return { text: "Connecting…", tone: "warn" };
    case "stopped":
      return { text: STOPPED[snapshot.stopReason ?? "refused"], tone: "bad" };
    default:
      return { text: "Not connected", tone: "warn" };
  }
}

/** 42 s · 12 min · 1 h 5 min */
function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(id);
  }, [everyMs]);
  return now;
}

type DeliveryTest =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "delivered"; ms: number }
  | { kind: "lost"; listening: boolean | null };

const DELIVERY_TIMEOUT_MS = 5_000;

/**
 * Sends a ping and times the `pong` that comes back through the stream: the POST, the `NOTIFY`,
 * the listener and the stream, which is the whole path every chat message will take.
 */
async function testDelivery(): Promise<DeliveryTest> {
  const pingId = crypto.randomUUID();
  const started = performance.now();
  let off = () => {};
  const arrived = new Promise<number | null>((resolve) => {
    const timer = window.setTimeout(() => resolve(null), DELIVERY_TIMEOUT_MS);
    off = realtime().on("pong", (data) => {
      if (data.pingId !== pingId) return;
      window.clearTimeout(timer);
      resolve(performance.now());
    });
  });
  try {
    const answer = await api<ChatPingResult>("/api/chat/stream/ping", {
      method: "POST",
      body: { pingId },
    });
    const at = await arrived;
    return at === null
      ? { kind: "lost", listening: answer.listening }
      : { kind: "delivered", ms: Math.round(at - started) };
  } catch {
    return { kind: "lost", listening: null };
  } finally {
    off();
  }
}

function deliveryText(test: DeliveryTest): string | null {
  switch (test.kind) {
    case "running":
      return "Sending…";
    case "delivered":
      return `Delivered in ${test.ms} ms`;
    case "lost":
      if (test.listening === null) return "The test could not be sent.";
      return test.listening
        ? "No answer in 5 s. The server is listening, so the connection did not deliver it."
        : "No answer in 5 s. The server is not listening to the database right now.";
    default:
      return null;
  }
}

function Row({
  label,
  children,
  first,
}: {
  label: string;
  children: React.ReactNode;
  first?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 px-3.5 py-2.5",
        !first && "border-t border-divider",
      )}
    >
      <span className="text-[13px] text-ink">{label}</span>
      <span className="text-right text-[12.5px] text-ink-700 tabular-nums">{children}</span>
    </div>
  );
}

function LiveConnection() {
  const snapshot = useRealtime();
  const presence = useChatPresence();
  const now = useNow(1_000);
  const [test, setTest] = useState<DeliveryTest>({ kind: "idle" });
  const status = statusOf(snapshot);
  const tone = JOB_TONE_COLORS[status.tone];
  const online = presence.data?.online.length;

  return (
    <>
      <Row label="Status" first>
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block size-2 rounded-full"
            style={{ backgroundColor: tone.fg }}
          />
          <span style={{ color: tone.fg }}>{status.text}</span>
          {snapshot.status === "stopped" && (
            <Button variant="text" size="sm" onClick={reconnectRealtime}>
              Reconnect
            </Button>
          )}
        </span>
      </Row>
      <Row label="Connected for">
        {snapshot.openedAt ? duration(now - snapshot.openedAt) : "–"}
      </Row>
      <Row label="Last signal">
        {snapshot.lastEventAt ? `${duration(now - snapshot.lastEventAt)} ago` : "–"}
      </Row>
      <Row label="Since this page opened">
        {plural(snapshot.heartbeats, "heartbeat")}, {plural(snapshot.reconnects, "reconnect")}
      </Row>
      <Row label="Online now">
        {online === undefined ? "–" : plural(online, "person", "people")}
      </Row>
      <Row label="Delivery test">
        <span className="inline-flex items-center gap-3">
          {deliveryText(test) && (
            <span
              className={cn(
                test.kind === "delivered" && "text-success",
                test.kind === "lost" && "text-danger-text",
              )}
            >
              {deliveryText(test)}
            </span>
          )}
          <Button
            variant="secondary"
            size="sm"
            disabled={snapshot.status !== "open" || test.kind === "running"}
            onClick={() => {
              setTest({ kind: "running" });
              void testDelivery().then(setTest);
            }}
          >
            Test delivery
          </Button>
        </span>
      </Row>
    </>
  );
}
