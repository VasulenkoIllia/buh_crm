import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  ACTIVITY_KEYS,
  groupOf,
  isActivityKey,
  renderTitle,
  type ActivityGroup,
} from "@shared/activity";
import type { ActivityEntry, ActivityRow } from "@shared/schema/activity";
import { cn } from "@/shared/lib/cn";
import { fmtDateTime, relativeTime } from "@/shared/lib/format";
import { Button } from "@/shared/ui/button";
import { Chip } from "@/shared/ui/chip";
import { Select } from "@/shared/ui/field";
import { SearchInput } from "@/shared/ui/search-input";
import { Segmented } from "@/shared/ui/segmented";
import { useActivity } from "./activity.api";

/**
 * **Who did what, when, and to whom — read as gestures, not as rows.**
 *
 * The owner's requirement was that this shows who did what rather than a wall of rows, and one
 * human gesture is often several writes: saving a client edits the client, reconciles two companies
 * and touches a subscription. The API groups by `correlationId`; this renders one line per gesture
 * that opens into its individual changes (docs/modules/activity-log.md §6, §12).
 *
 * **Every sentence comes from `shared/activity.ts`.** Nothing here knows what `client.updated`
 * means, and that is what makes a new event a constant rather than a constant plus a case in a
 * switch statement here. It is also why the registry's titles carry exactly two placeholders.
 *
 * Used twice: the Settings tab, with filters, and the client card's Activity tab, without them —
 * "an entity's own history appears on the entity" (§12, rule 2).
 */

const GROUPS: { value: ActivityGroup | ""; label: string }[] = [
  { value: "", label: "Everything" },
  { value: "people", label: "People" },
  { value: "clients", label: "Clients" },
  { value: "work", label: "Work" },
  { value: "money", label: "Money" },
  { value: "comms", label: "Mail" },
  { value: "files", label: "Files" },
  { value: "system", label: "System" },
];

const SINCE: { value: "7" | "30" | ""; label: string }[] = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "", label: "All" },
];

/**
 * "Client · updated", built from the key rather than from a copy field.
 *
 * 138 events would otherwise need 138 more strings whose only job is to appear in one `<select>`,
 * and the naming scheme (`<subject>.<verb_past>`, §4.1) exists precisely so a key can be read.
 */
function actionLabel(key: string): string {
  const [subject, verb] = key.split(".");
  const words = (s: string) => s.replace(/_/g, " ");
  return `${words(subject).replace(/^./, (c) => c.toUpperCase())} · ${words(verb)}`;
}

interface ActivityFeedProps {
  /** locks the feed to one client — everything that concerns them, across every subject */
  clientId?: string;
  /** the client card's shape: no filter strip, a shorter page */
  compact?: boolean;
}

export function ActivityFeed({ clientId, compact = false }: ActivityFeedProps) {
  const [group, setGroup] = useState<ActivityGroup | "">("");
  const [action, setAction] = useState("");
  const [q, setQ] = useState("");
  const [since, setSince] = useState<"7" | "30" | "">(compact ? "" : "30");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const from = useMemo(() => {
    if (!since) return undefined;
    const d = new Date();
    d.setDate(d.getDate() - Number(since));
    return d.toISOString();
  }, [since]);

  const { data, isLoading, error } = useActivity({
    clientId,
    group: group || undefined,
    action: action || undefined,
    q: q.trim() || undefined,
    from,
    page,
    pageSize: compact ? 15 : 25,
  });

  // one `now` per render, so every row on screen agrees with every other
  const now = new Date();

  const reset = <T,>(set: (v: T) => void) => (value: T) => {
    set(value);
    setPage(1);
  };

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const actions = useMemo(
    () =>
      ACTIVITY_KEYS.filter((key) => !group || groupOf(key) === group)
        .map((key) => ({ value: key, label: actionLabel(key) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [group],
  );

  return (
    <div className="space-y-3">
      {!compact && (
        <div className="flex flex-wrap items-center gap-2">
          {/* the four filters are the four indexes — a filter with no index behind it is a
              promise the table cannot keep at 200k rows a year (§5.2) */}
          <div className="flex flex-wrap gap-1.5">
            {GROUPS.map((g) => (
              <button
                key={g.value || "all"}
                type="button"
                onClick={() => {
                  reset(setGroup)(g.value);
                  setAction("");
                }}
                className={cn(
                  "rounded-(--radius-field) border px-2.5 py-1 text-[12px]",
                  group === g.value
                    ? "border-primary bg-primary/8 text-primary"
                    : "border-border text-muted hover:text-ink",
                )}
              >
                {g.label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Select
              value={action}
              onChange={(e) => reset(setAction)(e.target.value)}
              className="w-56"
            >
              <option value="">Any action</option>
              {actions.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </Select>
            <SearchInput
              value={q}
              onChange={(e) => reset(setQ)(e.target.value)}
              placeholder="Who, or what it happened to"
              className="w-64"
            />
            <Segmented value={since} onChange={reset(setSince)} options={SINCE} />
          </div>
        </div>
      )}

      {isLoading && !data && <p className="text-[13px] text-muted">Loading…</p>}
      {error && <p className="text-[13px] text-danger-text">Failed to load the activity log.</p>}

      {data && data.entries.length === 0 && (
        <p className="text-[13px] text-muted">
          {clientId
            ? "Nothing has been recorded for this client yet."
            : "Nothing matches those filters."}
        </p>
      )}

      {data && data.entries.length > 0 && (
        <ul className="divide-y divide-border rounded-(--radius-card) border border-border bg-surface">
          {data.entries.map((entry) => (
            <Entry
              key={entry.correlationId}
              entry={entry}
              compact={compact}
              now={now}
              open={open.has(entry.correlationId)}
              onToggle={() => toggle(entry.correlationId)}
            />
          ))}
        </ul>
      )}

      {data && data.total > data.pageSize && (
        <div className="flex items-center justify-between text-[12px] text-muted">
          <span>
            {(data.page - 1) * data.pageSize + 1}–
            {Math.min(data.page * data.pageSize, data.total)} of {data.total}
            {/* a ceiling, not a count: an exact total of a two-year log costs a scan of every
                matching gesture on every page load, and a pager does not need one */}
            {data.totalIsExact ? "" : "+"}
          </span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              disabled={data.page === 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              disabled={data.page * data.pageSize >= data.total}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One gesture. The first row carries the sentence; the rest are behind the chevron.
 *
 * A gesture with one row still expands, because that is where `changes` lives and "which field
 * moved" is the second question after "what happened".
 */
function Entry({
  entry,
  compact,
  now,
  open,
  onToggle,
}: {
  entry: ActivityEntry;
  compact: boolean;
  now: Date;
  open: boolean;
  onToggle: () => void;
}) {
  const head = entry.rows[0];
  const extra = entry.rows.length - 1;
  const problem = entry.rows.find((r) => r.outcome !== "ok");

  return (
    <li className="px-3.5 py-2.5">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-2 text-left"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="mt-0.5 size-3.5 flex-none text-faint" />
        ) : (
          <ChevronRight className="mt-0.5 size-3.5 flex-none text-faint" />
        )}
        <span className="min-w-0 flex-1">
          <span className="text-[13px] text-ink">{sentence(head, entry)}</span>
          {/*
            **Whose.** "Serhii paused Payroll" is half an answer — the half that says what was done
            and not to whom. The row has carried the client since the first migration; it just had
            nowhere to be read (found on production by the owner, 2026-09-08).

            Hidden on the client card, where every row is that client and repeating the name on all
            of them says nothing.
          */}
          {!compact && head?.clientLabel && head.clientLabel !== head.subjectLabel && (
            <span className="ml-2 text-[13px] text-muted">· {head.clientLabel}</span>
          )}
          {extra > 0 && (
            <span className="ml-1.5 text-[12px] text-faint">
              +{extra} more in the same action
            </span>
          )}
        </span>
        {/*
          Only when it is NOT ok: a green tick on every row is noise, and the rows worth looking at
          are the ones that were refused or failed.

          **And the two are not the same word.** `refused` is a gate or a role saying no — a
          permissions question. `failed` is the app or the database saying no — an incident. The
          column keeps them apart precisely so somebody can tell, and labelling a failure "refused"
          here threw that away in the one place a person actually reads it (seen on screen with a
          malformed DELETE, 2026-09-08).
        */}
        {problem && (
          <Chip tone="amber" size="sm" title={outcomeHint(problem)}>
            {problem.outcome === "refused" ? (problem.refusalCode ?? "refused") : "failed"}
          </Chip>
        )}
        <span
          className="flex-none text-[12px] text-faint"
          title={fmtDateTime(entry.occurredAt)}
        >
          {relativeTime(new Date(entry.occurredAt), now)}
        </span>
      </button>

      {open && (
        /*
          A rule down the left, so the detail reads as belonging to the row above it rather than as
          the next row starting.
        */
        <div className="mt-2 ml-1.5 space-y-2 border-l-2 border-divider pl-3.5">
          {entry.rows.map((row) => (
            <div key={row.id} className="text-[12px]">
              {/*
                The head sentence is NOT repeated. A gesture with one row already says what it was
                in the line above; printing it again in grey adds a second line that says nothing
                and makes the one line that does — the diff — harder to find (user, 2026-09-08).
              */}
              {entry.rows.length > 1 && (
                <div className="text-ink-700">{sentence(row, entry)}</div>
              )}
              <Changes row={row} />
            </div>
          ))}
          {/*
            Where it came from. `text-muted` rather than `text-faint`: faint is #9aa1ab, which is
            about 2.6:1 on white and under the readable threshold for text this size — the IP was
            on screen and could not be seen.
          */}
          <div className="border-t border-divider pt-1.5 text-[11px] text-muted">
            {entry.actorLabel}
            {entry.ip ? ` · ${entry.ip}` : ""}
            {head?.route ? ` · ${head.method} ${head.route}` : ""}
          </div>
        </div>
      )}
    </li>
  );
}

function outcomeHint(row: ActivityRow): string {
  return row.outcome === "refused"
    ? "A gate or a role said no — this person was not allowed to do it"
    : "The app or the database said no — the request was allowed but did not go through";
}

/** The registry's sentence, or the raw key when a row names an event this build has dropped. */
function sentence(row: ActivityRow | undefined, entry: ActivityEntry): string {
  if (!row) return "—";
  if (!isActivityKey(row.action)) return `${row.action} (${row.subjectLabel ?? "—"})`;
  return renderTitle(row.action, {
    actorLabel: entry.actorLabel,
    subjectLabel: row.subjectLabel,
    clientLabel: row.clientLabel,
  });
}

/**
 * The fields that moved — `{ phone: { from, to } }` and nothing else.
 *
 * §5.1 is the reason this can be rendered flat and without care: the log holds field diffs, never
 * whole records, so there is no shape here that could turn the screen into a way of reading what a
 * closed gate refuses.
 */
function Changes({ row }: { row: ActivityRow }) {
  const changes = row.changes as Record<string, unknown> | null;
  if (!changes || Object.keys(changes).length === 0) return null;
  return (
    /*
      **The value that is true NOW carries the weight.**
      A diff read as one grey run of text made the reader parse it to find which half was current.
      The field is a label, the old value steps back, and what the record says today is in ink.
    */
    <ul className="mt-0.5 space-y-0.5">
      {Object.entries(changes).map(([field, value]) => (
        <li key={field} className="flex gap-2">
          <span className="w-28 flex-none text-muted">{field.replace(/_/g, " ")}</span>
          {/* one line, with the whole value on hover: a description is a paragraph, and a row
              that grows to hold one buries the diffs above it */}
          <span className="min-w-0 flex-1 truncate" title={plainPair(value)}>
            <Value value={value} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function Value({ value }: { value: unknown }) {
  if (isPair(value)) {
    return (
      <>
        {/*
          `text-muted`, not `muted-400`: the value that WAS is still something a person may need to
          read, and 3.14:1 on white is under the threshold. The hierarchy is bought with the arrow
          and with ink on the current value — 4.8 against 16.9 — not by making half the diff faint.
        */}
        <span className="text-muted">{plainly(value.from)}</span>
        <span className="px-1 text-faint" aria-label="became">
          →
        </span>
        <span className="text-ink">{plainly(value.to)}</span>
      </>
    );
  }
  return <span className="text-ink">{plainly(value)}</span>;
}

function isPair(value: unknown): value is { from: unknown; to: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "from" in (value as object) &&
    "to" in (value as object)
  );
}

/** The same thing as one string, for the hover title. */
function plainPair(value: unknown): string {
  return isPair(value) ? `${plainly(value.from)} → ${plainly(value.to)}` : plainly(value);
}

function plainly(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}
