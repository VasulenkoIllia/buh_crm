import { Suspense, useState } from "react";
import { ActivityFeed, ActivityPolicySection } from "@/modules/activity";
import { Segmented } from "@/shared/ui/segmented";

/**
 * **Settings → Activity: the log, and the switches that decide what goes into it.**
 *
 * Two halves rather than two tabs, because they are one subject read from two ends — "what has
 * happened" and "what do we record". A firm looking at a noisy line in the feed should be able to
 * silence it without leaving the screen it noticed it on.
 *
 * Not a sidebar item: a log nobody opens daily does not earn a permanent slot
 * (docs/modules/activity-log.md §15).
 */
export function ActivitySection() {
  const [view, setView] = useState<"log" | "events">("log");

  return (
    <div className="space-y-4">
      {/* `Segmented` stretches to its container, and two options across a 960px panel read as a
          banner rather than as a control — it is a choice between two views, not a headline */}
      <div className="w-fit">
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: "log", label: "The log" },
            { value: "events", label: "What is recorded" },
          ]}
        />
      </div>
      <Suspense fallback={<p className="text-[13px] text-muted">Loading…</p>}>
        {view === "log" ? <ActivityFeed /> : <ActivityPolicySection />}
      </Suspense>
    </div>
  );
}
