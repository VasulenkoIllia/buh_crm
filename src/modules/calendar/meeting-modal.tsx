import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import type { Meeting } from "@shared/schema/calendar";
import { MEETING_DURATION_PRESETS } from "@shared/schema/calendar";
import { useCatalog } from "@/modules/catalog";
import { useClient } from "@/modules/clients";
import { useAssignees, useTaskTargets, type TaskTargetInfo } from "@/modules/tasks";
import { cn } from "@/shared/lib/cn";
import { firmWallClockToInstant, firmZoneAbbr, instantToFirmWallClock } from "@/shared/lib/tz";
import { useDebounced } from "@/shared/lib/use-debounced";
import { userLabel } from "@/shared/ui/avatar";
import { Button } from "@/shared/ui/button";
import { AssigneePicker } from "@/shared/ui/assignee-picker";
import { FormField, Input, Textarea } from "@/shared/ui/field";
import { Modal } from "@/shared/ui/modal";
import { pillCls } from "@/shared/ui/pill";
import { SearchSelect } from "@/shared/ui/search-select";
import { Segmented } from "@/shared/ui/segmented";
import { useConflicts, useCreateMeeting, useMeeting, useUpdateMeeting } from "./calendar.api";
import { fmtRange } from "./grid";

/**
 * Booking a meeting.
 *
 * The clash warning is live and **never blocks**: it names who is already busy and with what, and
 * the Save button stays enabled. People double-book deliberately, and a check that can't be
 * overridden gets worked around by not using the app at all.
 */

/**
 * Date and time are two separate inputs rather than one `datetime-local`.
 *
 * `datetime-local` is barely editable in Safari — there is no picker and the segments fight you,
 * which is why the time could not be changed at all (user, 2026-08-06). Two plain native controls
 * are obvious, keyboard-friendly and identical everywhere.
 *
 * Both carry a wall clock with no zone attached, and `new Date(...)` would read it in the BROWSER's
 * zone. Typing 09:00 has to mean 09:00 in the office whoever is typing, so both directions go
 * through the firm's clock.
 */
const splitInstant = (iso: string): { date: string; time: string } => {
  const [date, time] = instantToFirmWallClock(iso).split("T");
  return { date, time };
};
const joinToInstant = (date: string, time: string): string =>
  firmWallClockToInstant(`${date}T${time}`).toISOString();

/** Half-hour steps, so the common case is two clicks and the odd one is still typable. */
const TIME_STEP_SECONDS = 1800;

/** Only asked when the meeting has a client — a lead holds no services to route through. */
type TaskMode = "internal" | "service";

export function MeetingModal({
  meetingId,
  defaultStartAt,
  defaultClientId,
  defaultLeadId,
  onClose,
  onSaved,
}: {
  meetingId?: string;
  defaultStartAt?: string;
  defaultClientId?: string;
  defaultLeadId?: string;
  onClose: () => void;
  /** where it landed — the calendar uses this to take you to it (see `onSaved` on the page) */
  onSaved?: (meeting: Meeting) => void;
}) {
  const navigate = useNavigate();
  const editing = !!meetingId;
  const { data: existing } = useMeeting(meetingId);
  const { data: team } = useAssignees();
  const { data: targets } = useTaskTargets();
  const create = useCreateMeeting();
  const update = useUpdateMeeting();

  const [title, setTitle] = useState("");
  const [target, setTarget] = useState("");
  const [start, setStart] = useState(() =>
    splitInstant(defaultStartAt ?? new Date().toISOString()),
  );
  const [duration, setDuration] = useState(60);
  const [link, setLink] = useState("");
  const [description, setDescription] = useState("");
  const [participants, setParticipants] = useState<string[]>([]);
  const [withTask, setWithTask] = useState(false);
  const [taskMode, setTaskMode] = useState<TaskMode>("internal");
  const [subscriptionId, setSubscriptionId] = useState("");
  /**
   * Two kinds of error, shown in two places, because one of them was invisible.
   *
   * `titleError` sits under the Title field. `error` is for anything the server says and sits at
   * the TOP of the form. Both used to be one message rendered after the Notes box — below the fold
   * in a scrolled modal, so clicking Save with an empty title looked like nothing happened at all
   * (user, 2026-08-06).
   */
  const [error, setError] = useState<string | null>(null);
  const [titleError, setTitleError] = useState<string | null>(null);

  // seed the form once its meeting arrives (editing), or from where it was opened (creating)
  useEffect(() => {
    if (existing) {
      setTitle(existing.title);
      setTarget(
        existing.clientId
          ? `client:${existing.clientId}`
          : existing.leadId
            ? `lead:${existing.leadId}`
            : "",
      );
      setStart(splitInstant(existing.startAt));
      setDuration(existing.durationMinutes);
      setLink(existing.link ?? "");
      setDescription(existing.description ?? "");
      setParticipants(existing.participantIds);
    } else if (defaultClientId) {
      setTarget(`client:${defaultClientId}`);
    } else if (defaultLeadId) {
      setTarget(`lead:${defaultLeadId}`);
    }
  }, [existing, defaultClientId, defaultLeadId]);

  const [kind, targetId] = target ? target.split(":") : [null, null];
  const clientId = kind === "client" ? targetId! : undefined;
  const { data: client } = useClient(withTask && taskMode === "service" ? clientId : undefined);

  const startAt = start.date && start.time ? joinToInstant(start.date, start.time) : null;
  // the slot settles before anyone is asked about it — see `useDebounced`
  const slot = useDebounced({ startAt, duration, participants });
  const { data: conflicts } = useConflicts({
    startAt: slot.startAt,
    durationMinutes: slot.duration,
    userIds: slot.participants,
    excludeMeetingId: meetingId,
  });

  const nameOf = useMemo(() => {
    const map = new Map((team ?? []).map((u) => [u.id, userLabel(u)]));
    return (id: string) => map.get(id) ?? "someone";
  }, [team]);

  // only services actually RUNNING can take work — the same rule the task form follows, and the
  // reason a paused service is refused server-side rather than silently accepted
  const { data: catalog } = useCatalog();
  const serviceName = useMemo(
    () => new Map((catalog ?? []).map((s) => [s.id, s.name])),
    [catalog],
  );
  const serviceOptions = (client?.subscriptions ?? [])
    .filter((s) => s.active)
    .map((s) => ({ value: s.id, label: serviceName.get(s.serviceId) ?? "Service" }));

  const busy = create.isPending || update.isPending;

  async function save() {
    setError(null);
    setTitleError(null);
    let saved: Meeting | undefined;
    if (!title.trim()) return setTitleError("Give the meeting a title");
    if (!startAt) return setError("Pick a date and a start time");
    try {
      if (editing) {
        saved = await update.mutateAsync({
          id: meetingId!,
          input: {
            title,
            startAt,
            durationMinutes: duration,
            link: link || null,
            description: description || null,
            participantIds: participants,
            // only ever ATTACHES one; the server refuses to replace a task already worked on
            task:
              withTask && !existing?.taskId
                ? { mode: taskMode, subscriptionId: taskMode === "service" ? subscriptionId : null }
                : undefined,
          },
        });
      } else {
        saved = await create.mutateAsync({
          title,
          clientId: kind === "client" ? targetId : null,
          leadId: kind === "lead" ? targetId : null,
          startAt,
          durationMinutes: duration,
          link: link || null,
          description: description || null,
          participantIds: participants,
          task: withTask
            ? { mode: taskMode, subscriptionId: taskMode === "service" ? subscriptionId : null }
            : null,
        });
      }
      if (saved) onSaved?.(saved);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Modal
      title={editing ? "Meeting" : "New meeting"}
      open
      onClose={onClose}
      size="lg"
      footer={
        <>
          {editing && existing?.taskId && (
            <Button
              variant="text"
              className="mr-auto"
              onClick={() => navigate(`/tasks?task=${existing.taskId}`)}
            >
              Open its task →
            </Button>
          )}
          {editing && existing && !existing.cancelledAt && (
            <Button
              variant="text"
              className="text-danger-text hover:text-danger-text"
              disabled={busy}
              onClick={async () => {
                // the task is deliberately left alone: a meeting called off is often one being
                // rearranged, and the work usually still needs doing. Say so rather than let the
                // person discover it on the board.
                const note = existing.taskId
                  ? "\n\nIts task stays on the board — close that separately if the work is off too."
                  : "";
                if (!window.confirm(`Call this meeting off? It leaves the calendar.${note}`)) return;
                await update.mutateAsync({ id: meetingId!, input: { cancelled: true } });
                onClose();
              }}
            >
              Cancel meeting
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        {error && (
          <p className={cn(
            "rounded-(--radius-card) border border-[#f0c9c9] bg-[#fdf5f5] px-3 py-2",
            "text-[13px] text-danger-text",
          )}>
            {error}
          </p>
        )}
        {existing?.cancelledAt && (
          <p className="rounded-(--radius-card) bg-divider px-3 py-2 text-[13px] text-muted">
            This meeting was called off. Saving puts it back on the calendar.
          </p>
        )}

        <FormField label="Title" htmlFor="m-title" error={titleError ?? undefined}>
          <Input
            id="m-title"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (titleError) setTitleError(null);
            }}
            placeholder="e.g. Quarterly review"
            aria-invalid={!!titleError}
          />
        </FormField>

        <div className="grid grid-cols-2 gap-3.5">
          <FormField label="Client or lead" htmlFor="m-target">
            <SearchSelect
              id="m-target"
              value={target}
              disabled={editing}
              placeholder={editing ? "Can't be changed after booking" : "Search…"}
              emptyLabel="Internal — nobody outside the firm"
              options={(targets ?? []).map((t: TaskTargetInfo) => ({
                value: `${t.kind}:${t.id}`,
                label: t.name,
                hint: t.kind === "lead" ? "(lead)" : undefined,
              }))}
              onChange={(v) => {
                setTarget(v);
                setSubscriptionId("");
                if (!v.startsWith("client:")) setTaskMode("internal");
              }}
            />
          </FormField>
          <FormField label={`Starts (${firmZoneAbbr()})`} htmlFor="m-date">
            <div className="flex gap-2">
              <Input
                id="m-date"
                type="date"
                className="flex-1"
                value={start.date}
                onChange={(e) => setStart((p) => ({ ...p, date: e.target.value }))}
              />
              <Input
                type="time"
                aria-label={`Start time (${firmZoneAbbr()})`}
                className="w-[110px]"
                step={TIME_STEP_SECONDS}
                value={start.time}
                onChange={(e) => setStart((p) => ({ ...p, time: e.target.value }))}
              />
            </div>
          </FormField>
        </div>

        <FormField label="Duration">
          <div className="flex flex-wrap items-center gap-1.5">
            {MEETING_DURATION_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                className={pillCls(duration === p)}
                onClick={() => setDuration(p)}
              >
                {p} min
              </button>
            ))}
            <Input
              type="number"
              min={5}
              max={1440}
              aria-label="Duration in minutes"
              className="w-24"
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value) || 0)}
            />
            {startAt && duration > 0 && (
              <span className="text-[12px] text-muted-400">{fmtRange(startAt, duration)}</span>
            )}
          </div>
        </FormField>

        <FormField label="Who's coming">
          <AssigneePicker
            users={team ?? []}
            selected={(id) => participants.includes(id)}
            onToggle={(id) =>
              setParticipants((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
            }
          />
        </FormField>

        {!!conflicts?.length && (
          <div className="rounded-(--radius-card) border border-[#e8d3a8] bg-[#fdf8ee] px-3 py-2 text-[13px] text-[#8a5a12]">
            <div className="flex items-center gap-1.5 font-medium">
              <AlertTriangle size={14} strokeWidth={2} />
              Someone is already booked
            </div>
            <ul className="mt-1 space-y-0.5">
              {conflicts.map((c) => (
                <li key={c.meetingId}>
                  {c.userIds.map(nameOf).join(", ")} — “{c.title}”,{" "}
                  {fmtRange(c.startAt, c.durationMinutes)}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[12px] opacity-80">
              You can book it anyway — this is a heads-up, not a block.
            </p>
          </div>
        )}

        {!existing?.taskId && (
          <div className="rounded-(--radius-card) border border-[#e9edf2] bg-[#fbfcfd] p-3">
            {/* One checkbox, always the same shape. The TYPE question appears underneath only when
                there is actually a choice to make — a client's meeting. Before, the control itself
                grew a third option when a client was picked, so a form opened without one looked
                like the feature was missing (user, 2026-08-06). */}
            <label className="flex cursor-pointer items-center gap-2 text-[13px] font-medium">
              <input
                type="checkbox"
                checked={withTask}
                onChange={(e) => setWithTask(e.target.checked)}
              />
              Create a task for this meeting
            </label>

            {withTask && (
              <div className="mt-2.5 space-y-2 border-t border-[#eef1f5] pt-2.5">
                {clientId ? (
                  <>
                    <Segmented
                      value={taskMode}
                      onChange={(v) => setTaskMode(v)}
                      options={[
                        { value: "internal" as const, label: "Internal" },
                        { value: "service" as const, label: "Through a service" },
                      ]}
                    />
                    {taskMode === "internal" ? (
                      <p className="text-[12px] text-faint">
                        The firm's own time, attributed to this client. Bills nothing.
                      </p>
                    ) : (
                      <>
                        <SearchSelect
                          value={subscriptionId}
                          options={serviceOptions}
                          placeholder={
                            serviceOptions.length === 0
                              ? "This client has no running service"
                              : "Which service does the work go through?"
                          }
                          emptyLabel="—"
                          ariaLabel="Service"
                          disabled={serviceOptions.length === 0}
                          onChange={setSubscriptionId}
                        />
                        <p className="text-[12px] text-faint">
                          Billed exactly like any other job on that service — a one-time service
                          will issue its invoice on its own trigger.
                        </p>
                      </>
                    )}
                  </>
                ) : (
                  <p className="text-[12px] text-faint">
                    {kind === "lead"
                      ? "Work on this lead — free, because a lead holds no services yet."
                      : "The firm's own time. Pick a client above if it should go through a service."}
                  </p>
                )}
                <p className="text-[12px] text-faint">
                  Due on the day of the meeting, assigned to you and everyone invited.
                </p>
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3.5">
          <FormField label="Link" htmlFor="m-link">
            <Input
              id="m-link"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="e.g. a video-call URL"
            />
          </FormField>
          <FormField label="Notes" htmlFor="m-desc">
            <Textarea
              id="m-desc"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </FormField>
        </div>

      </div>
    </Modal>
  );
}
