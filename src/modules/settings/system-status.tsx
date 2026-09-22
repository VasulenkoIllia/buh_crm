import {
  JOB_STATUS_TEXT,
  SYSTEM_JOBS,
  SYSTEM_JOB_AREAS,
  SYSTEM_JOB_KEYS,
  isHealthy,
  isSystemJobKey,
  jobStatus,
  type JobEventRow,
  type JobHealthRow,
  type JobStatus,
  type SystemJobKey,
} from "@shared/system-jobs";
import type { FileTotals, FirmStorage } from "@shared/schema/files";
import { plural } from "@shared/text";
import { Link } from "react-router-dom";
import { useAuth } from "@/app/auth";
import { fmtBytes, fmtDateTime, relativeTime } from "@/shared/lib/format";
import { cn } from "@/shared/lib/cn";
import { JOB_TONE_COLORS } from "@/shared/lib/colors";
import { InfoHint } from "@/shared/ui/info-hint";
import { LiveConnectionPanel } from "./live-connection";
import { useStorage, useSystemHealth } from "./settings.api";

/**
 * "Is the CRM quietly broken?" — asked and answered without opening a log.
 *
 * The whole screen is written for the person who runs the firm, not the person who deploys it.
 * There is a real background system here — nine jobs, some of them the only reason invoices and
 * tasks appear at all — and until now the only way to know it was alive was to read the server
 * log, which means: nobody knew. A job that stops does not announce itself; it just stops, and
 * the symptom arrives weeks later as "why has this client not been invoiced".
 *
 * NOT a log viewer, deliberately. A log viewer answers a developer's question. This answers
 * "should I be worried, and about what" — one line per job, in the firm's own words, with the
 * consequence spelled out rather than implied. The error text is here too, but behind the ⓘ, in
 * the position of a footnote rather than a headline.
 */
export function SystemStatusSection() {
  const { data, isLoading, error } = useSystemHealth();

  if (isLoading) return <p className="text-[13px] text-muted">Loading…</p>;
  if (error || !data)
    return <p className="text-[13px] text-danger-text">Failed to load the system status.</p>;

  const now = new Date(data.now);
  const bootedAt = new Date(data.bootedAt);
  const byName = new Map(data.jobs.map((j) => [j.name, j]));

  const statuses = SYSTEM_JOB_KEYS.map((key) => ({
    key,
    spec: SYSTEM_JOBS[key],
    row: byName.get(key),
    status: jobStatus(byName.get(key), SYSTEM_JOBS[key], now, bootedAt),
  }));
  const unwell = statuses.filter((s) => !isHealthy(s.status));
  // red only if something is actually red. A job that merely skipped work is amber on its own row,
  // and a banner that shouted red about it would disagree with the row it is summarising.
  const worst: "warn" | "bad" = unwell.some((s) => JOB_STATUS_TEXT[s.status].tone === "bad")
    ? "bad"
    : "warn";

  /**
   * Rows the registry does not know about — a job renamed in the code and not here, or one left
   * behind by an older version. Shown rather than dropped: silently hiding a job nobody named is
   * how this screen would start lying, and it is the exact failure the notifications registry
   * already has a test for.
   */
  const unknown = data.jobs.filter((j) => !isSystemJobKey(j.name));

  return (
    <div className="space-y-5">
      <Summary
        unwell={unwell.length}
        worst={worst}
        total={statuses.length}
        bootedAt={bootedAt}
        now={now}
      />

      {SYSTEM_JOB_AREAS.map((area) => {
        const inArea = statuses.filter((s) => s.spec.area === area.key);
        if (inArea.length === 0) return null;
        return (
          <section key={area.key}>
            <h3 className="mb-2 text-[12px] font-bold text-ink-700 uppercase">{area.label}</h3>
            <div className="overflow-hidden rounded-(--radius-panel) border border-border bg-surface shadow-(--shadow-card)">
              {inArea.map((s, i) => (
                <JobRow
                  key={s.key}
                  spec={s.spec}
                  row={s.row}
                  status={s.status}
                  first={i === 0}
                  now={now}
                />
              ))}
            </div>
          </section>
        );
      })}

      <LiveConnectionPanel />

      <StoragePanel />

      <Activity events={data.events} now={now} />

      {unknown.length > 0 && (
        <section>
          <h3 className="mb-2 text-[12px] font-bold text-ink-700 uppercase">Not recognised</h3>
          <p className="mb-2 text-[12px] text-muted">
            These ran on the server but are not in the list this screen knows about — usually a
            job that was renamed or removed. Harmless, and safe to ignore unless one is failing.
          </p>
          <div className="overflow-hidden rounded-(--radius-panel) border border-border bg-surface shadow-(--shadow-card)">
            {unknown.map((j, i) => (
              <div
                key={j.name}
                className={cn(
                  "flex items-center justify-between gap-3 px-3.5 py-2.5",
                  i > 0 && "border-t border-divider",
                )}
              >
                <span className="font-mono text-[12px] text-ink">{j.name}</span>
                <span
                  className="text-[12px]"
                  style={{
                    color: j.failStreak > 0 ? JOB_TONE_COLORS.bad.fg : undefined,
                  }}
                >
                  {j.failStreak > 0
                    ? `failed ${plural(j.failStreak, "time")} in a row`
                    : j.lastOkAt
                      ? `last ran ${fmtDateTime(j.lastOkAt)}`
                      : "never ran"}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

const totalsOf = (t: FileTotals) => `${plural(t.files, "file")} · ${fmtBytes(t.bytes)}`;

/**
 * **Storage** (files.md §4.4): everything the firm stores, split by where it sits, and how much
 * room the server's disk has left. A panel below the jobs, not a job: it has no schedule and no
 * state, so it stays out of the banner's count and colour. An admin's alone, since its figures are
 * firm-wide and ignore who may see what.
 */
function StoragePanel() {
  const { user } = useAuth();
  const admin = user?.role === "admin";
  const { data, error } = useStorage(admin);
  if (!admin) return null;

  const rows: { label: string; note?: string; totals: FileTotals }[] = data
    ? [
        { label: "My files", note: "everyone's together", totals: data.parts.mine },
        { label: "Company", totals: data.parts.company },
        {
          label: "Clients' zones",
          note:
            data.parts.archivedClients.files > 0
              ? `archived clients' included: ${totalsOf(data.parts.archivedClients)}`
              : undefined,
          totals: data.parts.clients,
        },
        { label: "On tasks, in no folder", totals: data.parts.unfiled },
        { label: "Trash", note: "removed for good after 30 days", totals: data.parts.trash },
        { label: "Avatars and logos", totals: data.parts.branding },
        {
          label: "Attached to secrets",
          note: "the vault's Trash included",
          totals: data.parts.secrets,
        },
        {
          label: "Sent in chats",
          note: "photos' thumbnails included",
          totals: data.parts.chats,
        },
      ]
    : [];

  return (
    <section>
      <h3 className="mb-2 text-[12px] font-bold text-ink-700 uppercase">Storage</h3>
      <div className="overflow-hidden rounded-(--radius-panel) border border-border bg-surface shadow-(--shadow-card)">
        {error ? (
          <p className="px-3.5 py-3 text-[12px] text-danger-text">
            The storage figures could not be read.
          </p>
        ) : !data ? (
          <p className="px-3.5 py-3 text-[12px] text-muted">Loading…</p>
        ) : (
          <>
            {rows.map((r, i) => (
              <div
                key={r.label}
                className={cn(
                  "flex items-baseline justify-between gap-3 px-3.5 py-2.5",
                  i > 0 && "border-t border-divider",
                )}
              >
                <span className="text-[13px] text-ink">
                  {r.label}
                  {r.note && <span className="ml-2 text-[12px] text-muted">{r.note}</span>}
                </span>
                <span className="text-[12.5px] whitespace-nowrap text-ink-700 tabular-nums">
                  {totalsOf(r.totals)}
                </span>
              </div>
            ))}
            <div className="flex items-baseline justify-between gap-3 border-t border-divider bg-[#fafbfc] px-3.5 py-2.5">
              <span className="text-[13px] font-semibold text-ink">Everything stored</span>
              <span className="text-[12.5px] font-semibold whitespace-nowrap text-ink tabular-nums">
                {totalsOf(data.all)}
              </span>
            </div>
            <p className="border-t border-divider px-3.5 py-2.5 text-[12px] text-muted">
              In the files bucket: {totalsOf(data.where.bucket)}
              {data.where.disk.files > 0 &&
                ` · still on the server's disk: ${totalsOf(data.where.disk)}`}
            </p>
            <DiskRow disk={data.disk} />
          </>
        )}
      </div>
    </section>
  );
}

/** The server's disk: the files are in the bucket, but the database and the backup copy grow here. */
function DiskRow({ disk }: { disk: FirmStorage["disk"] }) {
  if (!disk) {
    return (
      <p className="border-t border-divider px-3.5 py-2.5 text-[12px] text-muted">
        {"The server's disk could not be measured."}
      </p>
    );
  }
  const free = disk.total > 0 ? disk.free / disk.total : 0;
  const tone =
    free < 0.1 ? JOB_TONE_COLORS.bad : free < 0.2 ? JOB_TONE_COLORS.warn : JOB_TONE_COLORS.ok;
  return (
    <div className="border-t border-divider px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] text-ink">
          Server disk
          <span className="ml-2 text-[12px] text-muted">
            the database and the backup copy grow here
          </span>
        </span>
        <span
          className="text-[12.5px] whitespace-nowrap tabular-nums"
          style={{ color: tone.fg }}
        >
          {fmtBytes(disk.free)} free of {fmtBytes(disk.total)}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-divider">
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.round((1 - free) * 100)}%`, backgroundColor: tone.fg }}
        />
      </div>
    </div>
  );
}

/**
 * What has actually happened, newest first.
 *
 * The status lines above answer "is it working". This is the second question, and it arrives the
 * moment the first one says yes: *what has it been doing, and has anything gone wrong?* Without
 * it the screen states a verdict and shows none of the evidence, which is a thing to be believed
 * rather than a thing to be read (user, 2026-09-06).
 *
 * Only runs worth a line are here — a job that woke, found nothing and went back to sleep is not
 * one of them. That is decided on the server, at write time, so this list is short by construction
 * and not by truncation.
 */
function Activity({ events, now }: { events: JobEventRow[]; now: Date }) {
  if (events.length === 0) {
    return (
      <section>
        <h3 className="mb-2 text-[12px] font-bold text-ink-700 uppercase">Recent activity</h3>
        <div className="rounded-(--radius-panel) border border-border bg-surface px-3.5 py-3 shadow-(--shadow-card)">
          <p className="text-[12px] text-muted">
            Nothing yet. A line appears here whenever a job does something — creates tasks,
            issues invoices, sends notifications — or fails trying. An empty list on a new
            server is normal; the nightly jobs have not run yet.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <h3 className="mb-2 text-[12px] font-bold text-ink-700 uppercase">Recent activity</h3>
      <div className="overflow-hidden rounded-(--radius-panel) border border-border bg-surface shadow-(--shadow-card)">
        {events.map((e, i) => {
          const spec = isSystemJobKey(e.job) ? SYSTEM_JOBS[e.job] : null;
          const bad = !e.ok;
          const warn = e.ok && e.skipped > 0;
          return (
            <div
              key={e.id}
              className={cn(
                "flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3.5 py-2",
                i > 0 && "border-t border-divider",
              )}
            >
              <span className="w-[92px] flex-none text-[12px] text-muted-400 tabular-nums">
                {relative(new Date(e.at), now)}
              </span>
              <span className="text-[12.5px] font-medium">{spec?.label ?? e.job}</span>
              <span
                className="text-[12px]"
                style={{
                  color: bad
                    ? JOB_TONE_COLORS.bad.fg
                    : warn
                      ? JOB_TONE_COLORS.warn.fg
                      : undefined,
                }}
              >
                {bad
                  ? // the error itself, not "failed" — the reader is already looking at a red line
                    (e.error ?? "Failed")
                  : e.note}
                {warn ? ` · ${plural(e.skipped, "item")} skipped` : ""}
              </span>
              <span className="text-[12px] text-muted-400 tabular-nums">
                {duration(e.durationMs)}
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-1.5 text-[12px] text-muted">
        Runs that did nothing are left out on purpose — the reminder job wakes every minute, and
        listing those would bury everything else. Kept for 90 days.
      </p>
    </section>
  );
}

/** The one sentence somebody reads before deciding whether to keep reading. */
function Summary({
  unwell,
  worst,
  total,
  bootedAt,
  now,
}: {
  unwell: number;
  worst: "warn" | "bad";
  total: number;
  bootedAt: Date;
  now: Date;
}) {
  const ok = unwell === 0;
  const tone = JOB_TONE_COLORS[worst];
  return (
    <div
      className={cn(
        "rounded-(--radius-card) border px-3.5 py-3",
        ok ? "border-border bg-surface shadow-(--shadow-card)" : "border-transparent",
      )}
      style={ok ? undefined : { backgroundColor: tone.bg, borderColor: tone.fg }}
    >
      <p className="text-[13px] font-semibold" style={ok ? undefined : { color: tone.fg }}>
        {ok
          ? `All ${total} background jobs are running normally.`
          : // "1 job needs" / "3 jobs need" — the verb has to agree too, which is exactly the
            // trap that shipped "1 letters were not delivered" in the mailouts module
            `${plural(unwell, "job")} ${unwell === 1 ? "needs" : "need"} attention.`}
      </p>
      <p className="mt-1 text-[12px] text-muted">
        {ok
          ? "Nothing here needs doing. This screen is worth a glance after a deploy, or when something that should have happened by itself has not."
          : "Each one below says what it does and what goes wrong while it is not running."}{" "}
        The server was last restarted {relative(bootedAt, now)}.
      </p>
    </div>
  );
}

function JobRow({
  spec,
  row,
  status,
  first,
  now,
}: {
  spec: (typeof SYSTEM_JOBS)[SystemJobKey];
  row: JobHealthRow | undefined;
  status: JobStatus;
  first: boolean;
  now: Date;
}) {
  const text = JOB_STATUS_TEXT[status];

  /**
   * "Last tried", not "Last ran", when the most recent thing that happened was a failure — and the
   * note is withheld with it. A run that threw wrote no note, so anything still stored is from an
   * earlier, successful run: "failed 4 times in a row · 0 delivery reports applied" reads as
   * though the failing run had done that work.
   */
  const failedLast = !!row?.lastFailedAt && (!row.lastOkAt || row.lastFailedAt > row.lastOkAt);
  const last = failedLast ? row.lastFailedAt : (row?.lastOkAt ?? row?.lastFailedAt ?? null);

  return (
    <div className={cn("px-3.5 py-3", !first && "border-t border-divider")}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="text-[13px] font-medium">{spec.label}</span>
        <StatusDot tone={text.tone} />
        <span
          className="text-[12px]"
          style={{ color: text.tone === "ok" ? undefined : JOB_TONE_COLORS[text.tone].fg }}
        >
          {text.label}
        </span>
        <InfoHint label={`What ${spec.label} does`}>
          <p className="font-semibold">{spec.cadence}</p>
          <p className="mt-1.5">{spec.whenOk}</p>
          <p className="mt-1.5">
            <span className="font-semibold">If it stops: </span>
            {spec.whenBad}
          </p>
          {row?.lastError && (
            // the developer's half, and the only place it appears: an error message quotes a host
            // or a query back at you, which is noise on a screen meant to be glanceable
            <p className="mt-1.5 border-t border-divider pt-1.5 font-mono text-[11px] break-words">
              {row.lastError}
            </p>
          )}
        </InfoHint>
      </div>

      <p className="mt-1 text-[12px] text-muted">
        {last
          ? `${failedLast ? "Last tried" : "Last ran"} ${relative(new Date(last), now)}`
          : "Has not run yet"}
        {!failedLast && row?.lastNote ? ` · ${row.lastNote}` : ""}
        {!failedLast && row && row.lastSkipped > 0
          ? ` · ${plural(row.lastSkipped, "item")} skipped`
          : ""}
        {row && row.failStreak > 1
          ? ` · failed ${plural(row.failStreak, "time")} in a row`
          : ""}
        {/* how long it took. Collected on every run and worth showing: a job that has quietly gone
            from 400 ms to 40 s is the shape of a problem nothing else on this screen would name. */}
        {row?.lastDurationMs != null ? ` · took ${duration(row.lastDurationMs)}` : ""}
      </p>

      {/* only while something is wrong: a door you need is help, a door you do not is clutter */}
      {spec.fixAt && !isHealthy(status) && (
        <Link
          to={spec.fixAt.to}
          className="mt-1 inline-block text-[12px] font-medium text-primary-link hover:underline"
        >
          {spec.fixAt.label} →
        </Link>
      )}
    </div>
  );
}

function StatusDot({ tone }: { tone: "ok" | "warn" | "bad" }) {
  return (
    <span
      aria-hidden
      className="inline-block size-1.5 flex-none rounded-full"
      style={{ backgroundColor: JOB_TONE_COLORS[tone].fg }}
    />
  );
}

/**
 * "4 minutes ago" / "yesterday at 14:02".
 *
 * Relative up to a day because that is the window in which "how long ago" is the question, and
 * absolute after it because "3 days ago" is not something anybody can act on. `now` is passed in
 * rather than read here so every row on one render agrees with every other.
 */
/** "412 ms" / "1.4 s" / "2 min" — the unit a person would say, not always milliseconds. */
function duration(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

// moved to `shared/lib/format.ts` on 2026-09-08 — the activity log says the same thing, and one
// rule written twice eventually reads two ways
const relative = relativeTime;
