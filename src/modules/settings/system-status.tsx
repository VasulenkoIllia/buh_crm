import {
  JOB_STATUS_TEXT,
  SYSTEM_JOBS,
  SYSTEM_JOB_AREAS,
  SYSTEM_JOB_KEYS,
  isHealthy,
  isSystemJobKey,
  jobStatus,
  type JobHealthRow,
  type JobStatus,
  type SystemJobKey,
} from "@shared/system-jobs";
import { plural } from "@shared/text";
import { fmtDateTime } from "@/shared/lib/format";
import { cn } from "@/shared/lib/cn";
import { JOB_TONE_COLORS } from "@/shared/lib/colors";
import { InfoHint } from "@/shared/ui/info-hint";
import { useSystemHealth } from "./settings.api";

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
            <h3 className="mb-2 text-[12px] font-bold text-muted-400 uppercase">
              {area.label}
            </h3>
            <div className="overflow-hidden rounded-(--radius-card) border border-border">
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

      {unknown.length > 0 && (
        <section>
          <h3 className="mb-2 text-[12px] font-bold text-muted-400 uppercase">
            Not recognised
          </h3>
          <p className="mb-2 text-[12px] text-muted">
            These ran on the server but are not in the list this screen knows about — usually a
            job that was renamed or removed. Harmless, and safe to ignore unless one is failing.
          </p>
          <div className="overflow-hidden rounded-(--radius-card) border border-border">
            {unknown.map((j, i) => (
              <div
                key={j.name}
                className={cn(
                  "flex items-center justify-between gap-3 px-3.5 py-2.5",
                  i > 0 && "border-t border-divider",
                )}
              >
                <span className="font-mono text-[12px] text-muted">{j.name}</span>
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
        ok ? "border-border bg-surface" : "border-transparent",
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

      <p className="mt-1 text-[12px] text-muted-400">
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
      </p>
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
function relative(at: Date, now: Date): string {
  const mins = Math.round((now.getTime() - at.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${plural(mins, "minute")} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${plural(hours, "hour")} ago`;
  return `on ${fmtDateTime(at)}`;
}
