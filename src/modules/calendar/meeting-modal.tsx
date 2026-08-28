import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import type { Meeting } from "@shared/schema/calendar";
import { DEFAULT_MEETING_MINUTES, MEETING_DURATION_PRESETS } from "@shared/schema/calendar";
import { useCatalog } from "@/modules/catalog";
import { ClientFormModal, useClient } from "@/modules/clients";
import { LeadFormModal, useLead } from "@/modules/leads";
import { ClientLeadSearch, useAssignees, type Target } from "@/modules/tasks";
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
  const create = useCreateMeeting();
  const update = useUpdateMeeting();

  const [title, setTitle] = useState("");
  const [target, setTarget] = useState<Target | null>(null);
  /**
   * WHO at the client, when the meeting is with a particular person. Null means "the client at
   * large", which is what every meeting booked before contacts existed means and stays a normal
   * answer afterwards. Cleared whenever the target changes: a contact belongs to ONE client.
   */
  const [personId, setPersonId] = useState<string | null>(null);
  const [start, setStart] = useState(() =>
    splitInstant(defaultStartAt ?? new Date().toISOString()),
  );
  // 15 minutes: most meetings this firm books are short check-ins, and a preset that is usually
  // wrong costs a correction every single time (user, 2026-08-06)
  const [duration, setDuration] = useState(DEFAULT_MEETING_MINUTES);
  const [link, setLink] = useState("");
  const [description, setDescription] = useState("");
  const [participants, setParticipants] = useState<string[]>([]);
  /**
   * On by default — a meeting this firm books almost always has work attached, and ticking it every
   * time was a step nobody skipped on purpose (user, 2026-08-27).
   *
   * `!editing`, not `true`: the block below renders for an EXISTING meeting too, as long as it has
   * no task yet, and the update payload attaches one whenever this is set. Defaulting it on for
   * every open would mean editing a meeting's notes silently created a task nobody asked for.
   */
  const [withTask, setWithTask] = useState(!editing);
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
  // booking a meeting is often the FIRST thing a new client or lead gets — see the early return
  // below, which hands over to the same forms the Clients and Leads screens use
  const [clientFormOpen, setClientFormOpen] = useState(false);
  const [leadFormOpen, setLeadFormOpen] = useState(false);

  // seed the form once its meeting arrives (editing), or from where it was opened (creating)
  useEffect(() => {
    if (existing) {
      setTitle(existing.title);
      setTarget(
        existing.clientId
          ? { kind: "client", id: existing.clientId, label: existing.clientName ?? "Client" }
          : existing.leadId
            ? { kind: "lead", id: existing.leadId, label: existing.leadName ?? "Lead" }
            : null,
      );
      setPersonId(existing.personId);
      setStart(splitInstant(existing.startAt));
      setDuration(existing.durationMinutes);
      setLink(existing.link ?? "");
      setDescription(existing.description ?? "");
      setParticipants(existing.participantIds);
    } else if (defaultClientId) {
      setTarget({ kind: "client", id: defaultClientId, label: "" });
    } else if (defaultLeadId) {
      setTarget({ kind: "lead", id: defaultLeadId, label: "" });
    }
  }, [existing, defaultClientId, defaultLeadId]);

  const clientId = target?.kind === "client" ? target.id : undefined;
  /**
   * Fetched for ANY client now, not only when the task routes through a service: it carries both
   * the contacts to choose from and the phone number to show. One request, and the answer to
   * "what is their number" stops being a trip back to the client's card (user, 2026-08-28).
   */
  const { data: client } = useClient(clientId);
  const { data: lead } = useLead(target?.kind === "lead" ? target.id : null);

  /** the contact this meeting is with, and how to reach them — a person if one was named. */
  const person = client?.people.find((p) => p.id === personId) ?? null;
  const hasPeople = !!client && client.people.length > 0;
  const contact = person
    ? { phone: person.phone, email: person.email }
    : client
      ? { phone: client.phone, email: client.email }
      : lead
        ? { phone: lead.phone, email: lead.email }
        : null;

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
            // editable after the fact, unlike the target: you often learn who you are dealing
            // with only once the meeting is booked
            personId,
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
          clientId: target?.kind === "client" ? target.id : null,
          leadId: target?.kind === "lead" ? target.id : null,
          personId: target?.kind === "client" ? personId : null,
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

  // Creating a client or a lead inline pauses this modal and drops the new target back into it —
  // the same handover the task form uses, and the same two forms, so a client created here is
  // created exactly as it is on the Clients screen. Placed after every hook, not beside the state.
  if (leadFormOpen) {
    return (
      <LeadFormModal
        open
        onClose={() => setLeadFormOpen(false)}
        onSaved={(lead) => {
          setTarget({ kind: "lead", id: lead.id, label: lead.name });
          setPersonId(null); // and no contacts either — whoever was picked belonged elsewhere
          setSubscriptionId(""); // a lead has no services to bill through
          setTaskMode("internal");
        }}
      />
    );
  }
  if (clientFormOpen) {
    return (
      <ClientFormModal
        open
        onClose={() => setClientFormOpen(false)}
        onSaved={(c) => {
          setTarget({ kind: "client", id: c.id, label: c.displayName });
          setPersonId(null); // a contact belongs to ONE client, and this is a different one
          setSubscriptionId(""); // the picker below reloads against the new client
        }}
      />
    );
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
            {editing ? (
              // re-targeting is not supported: a linked task would be left pointing elsewhere
              <Input value={target?.label ?? "Internal"} disabled readOnly />
            ) : (
              <ClientLeadSearch
                value={target}
                onPick={(t) => {
                  setTarget(t);
                  setPersonId(null); // a contact belongs to one client; a new target voids it
                }}
                onNewClient={() => setClientFormOpen(true)}
                onNewLead={() => setLeadFormOpen(true)}
                onClear={() => {
                  setTarget(null);
                  setPersonId(null);
                  setSubscriptionId("");
                  setTaskMode("internal");
                }}
                placeholder="Search — or leave empty for an internal meeting"
              />
            )}
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

        {/**
         * WHO, and then how to reach them — one block, because they are one question.
         *
         * It sits here rather than under the target field, where the number first went: there it
         * landed beneath the "+ New client / + New lead" links and read as belonging to them, and
         * it repeated a name the pill underneath was already showing (user, 2026-08-28).
         *
         * The name is deliberately NOT in the line. Whoever the number belongs to is already on
         * screen — the selected pill when there are contacts, the target field when there are not.
         *
         * The pills appear only for a client that HAS contacts, so a firm with an empty People tab
         * sees the number and nothing else. "Contact", not "Who's coming": that row below is the
         * firm's own side of the table.
         */}
        {contact && (
          <FormField label="Contact">
            {hasPeople && (
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  className={pillCls(!personId)}
                  onClick={() => setPersonId(null)}
                >
                  The client
                </button>
                {client.people.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={pillCls(personId === p.id)}
                    onClick={() => setPersonId(p.id)}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}
            {/* The phone, or the email when there is no phone — the email is only ever the answer
                when the number isn't. */}
            <p className={cn("text-[12px] leading-snug text-muted", hasPeople && "mt-1.5")}>
              {contact.phone ? (
                <a
                  className="text-primary-link hover:underline"
                  href={`tel:${contact.phone.replace(/[^\d+]/g, "")}`}
                >
                  {contact.phone}
                </a>
              ) : contact.email ? (
                <span>{contact.email}</span>
              ) : (
                <span className="text-faint">no phone or email on file</span>
              )}
            </p>
          </FormField>
        )}

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
                    {target?.kind === "lead"
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
