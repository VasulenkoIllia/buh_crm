import { ACTIVITY_EVENTS, SUBJECT_GROUP, isActivityKey, type ActivityGroup } from "@shared/activity";
import { useAuth } from "@/app/auth";
import { cn } from "@/shared/lib/cn";
import { InfoHint } from "@/shared/ui/info-hint";
import { useActivityPolicies, useSetActivityPolicy, type ActivityPolicyRow } from "./activity.api";

/**
 * **What is recorded at all — the firm's own switch, one row per event.**
 *
 * It exists for `client.viewed`, which is the one event that would let a breach be scoped precisely
 * and is also the noisiest in the product: every navigation. It ships present and off, and turning
 * it on is a switch rather than a deploy (docs/modules/activity-log.md §3.2).
 *
 * But the reason it is worth a screen rather than a constant is the OTHER case: as the product
 * grows, an event that turns out to be noise can be silenced by the people reading the log, on the
 * day they decide, without waiting for a developer. That is the property the module needs to
 * survive the next eleven modules being wired into it.
 *
 * **Switching one off stops the recording, not the reading.** The rows already written stay, and
 * §11's retention is what eventually removes them. Said in the blurb, because "disabled" could
 * reasonably be read either way and a person acting on the wrong reading would be destroying
 * evidence they thought they were hiding.
 */

const GROUP_LABEL: Record<ActivityGroup, string> = {
  people: "People and access",
  clients: "Clients",
  work: "Work",
  money: "Money",
  comms: "Mail",
  files: "Files",
  system: "The system itself",
};

const ORDER: ActivityGroup[] = ["people", "clients", "work", "money", "comms", "files", "system"];

export function ActivityPolicySection() {
  const { data, isLoading, error } = useActivityPolicies();
  const setPolicy = useSetActivityPolicy();
  /**
   * **Reading what is recorded and CHANGING it are two different rights.**
   *
   * `GET /api/activity/policies` is the `activity` gate; the `PATCH` is that gate plus
   * `adminOnly`, which is deliberate — deciding what the firm records is not the same act as
   * reading what it recorded. The screen did not know, so a lead given the log met a row of live
   * buttons that answered 403 on click: "the screen renders perfectly and only the buttons are
   * dead", the failure this codebase names by date in three other files (audit, 2026-09-09).
   */
  const isAdmin = useAuth().user?.role === "admin";

  if (isLoading) return <p className="text-[13px] text-muted">Loading…</p>;
  if (error || !data)
    return <p className="text-[13px] text-danger-text">Failed to load the event list.</p>;

  const grouped = new Map<ActivityGroup, ActivityPolicyRow[]>();
  const unknown: ActivityPolicyRow[] = [];
  for (const row of data) {
    if (!isActivityKey(row.action)) {
      unknown.push(row);
      continue;
    }
    const group = SUBJECT_GROUP[ACTIVITY_EVENTS[row.action].subject];
    grouped.set(group, [...(grouped.get(group) ?? []), row]);
  }

  return (
    <div className="space-y-5">
      <p className="text-[12px] text-muted">
        Switching an event off stops it being recorded from now on. It does not remove what has
        already been written — the log keeps that for two years, and seven for sign-ins, role
        changes, access changes and records of data being destroyed. The bare record of the request
        itself is always kept, whatever is switched off here.
        {!isAdmin && " Only an administrator can change these."}
      </p>

      {ORDER.filter((g) => grouped.has(g)).map((group) => (
        <section key={group}>
          <h3 className="mb-2 text-[13px] font-semibold">{GROUP_LABEL[group]}</h3>
          <ul className="divide-y divide-border rounded-(--radius-card) border border-border bg-surface">
            {(grouped.get(group) ?? [])
              .sort((a, b) => a.action.localeCompare(b.action))
              .map((row) => (
                <li key={row.action} className="flex items-center gap-3 px-3.5 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="text-[13px] text-ink">{row.action}</span>
                    <span className="ml-2 text-[12px] text-muted">
                      {row.spec?.when}
                      {row.spec?.isRead ? " — reading is the act here" : ""}
                    </span>
                  </span>
                  {row.spec?.retention === "long" && (
                    <InfoHint label="Kept seven years">
                      Sign-ins, role changes, access changes and records of data being destroyed
                      outlive the two-year rule: they are the ones a dispute or an examination asks
                      about.
                    </InfoHint>
                  )}
                  {isAdmin ? (
                    <button
                      type="button"
                      disabled={setPolicy.isPending}
                      onClick={() =>
                        setPolicy.mutate({ action: row.action, enabled: !row.enabled })
                      }
                      className={cn(
                        "rounded-(--radius-btn-sm) border px-2.5 py-[5px] text-[11px] font-medium disabled:opacity-50",
                        row.enabled
                          ? "border-border bg-surface text-ink"
                          : "border-border bg-divider text-faint line-through",
                      )}
                    >
                      {row.enabled ? "Recorded" : "Not recorded"}
                    </button>
                  ) : (
                    // the same word, as a fact rather than a control — a reader still needs to know
                    // whether the line they are looking at is being recorded
                    <span
                      className={cn(
                        "px-2.5 py-[5px] text-[11px]",
                        row.enabled ? "text-muted" : "text-faint line-through",
                      )}
                    >
                      {row.enabled ? "Recorded" : "Not recorded"}
                    </span>
                  )}
                </li>
              ))}
          </ul>
        </section>
      ))}

      {/* A switch for an event this build no longer knows: shown rather than hidden, because a
          hidden dead switch is exactly the quiet lie this module exists to end. */}
      {unknown.length > 0 && (
        <section>
          <h3 className="mb-2 text-[13px] font-semibold">No longer in this version</h3>
          <p className="mb-2 text-[12px] text-muted">
            These were switched on or off by an earlier release and nothing writes them now. They
            are harmless; the rows they wrote are still in the log.
          </p>
          <ul className="text-[12px] text-faint">
            {unknown.map((row) => (
              <li key={row.action}>{row.action}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
