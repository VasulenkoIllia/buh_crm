import { useEffect, useMemo, useState } from "react";
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { Link, useSearchParams } from "react-router-dom";
import type { LeadStage } from "@shared/schema/enums";
import type { Lead } from "@shared/schema/lead";
import { cn } from "@/shared/lib/cn";
import { fmtDate } from "@/shared/lib/format";
import { Button } from "@/shared/ui/button";
import { Chip } from "@/shared/ui/chip";
import { StatusPill } from "@/shared/ui/pill";
import { Segmented } from "@/shared/ui/segmented";
import { ServiceChip, useCatalog } from "@/modules/catalog";
import { EntityTasks } from "@/modules/tasks";
import { useSettings } from "@/modules/settings";
import { ConvertLeadModal, LeadFormModal } from "./lead-modals";
import {
  useArchiveLead,
  useLead,
  useLeads,
  useMarkLost,
  useReopenLead,
  useUpdateLead,
} from "./leads.api";

const STAGES: Array<{ key: LeadStage; label: string }> = [
  { key: "first_contact", label: "First contact" },
  { key: "no_answer", label: "No answer" },
  { key: "set_up_meeting", label: "Set up meeting" },
  { key: "thinking", label: "Thinking" },
  { key: "on_hold", label: "On hold" },
  { key: "next_time", label: "Next time" },
];

export function LeadsPage() {
  const update = useUpdateLead();
  const [formOpen, setFormOpen] = useState(false);
  const [selected, setSelected] = useState<Lead | null>(null);
  // ?lead=<id> opens that lead's card — the way a task (or any other screen) links INTO a lead.
  // Fetched by id rather than looked up in the board list, so a won or lost lead opens too.
  const [searchParams, setSearchParams] = useSearchParams();
  const leadParam = searchParams.get("lead");
  const linked = useLead(leadParam);
  useEffect(() => {
    if (linked.data) setSelected(linked.data);
  }, [linked.data]);
  const closeDetails = () => {
    setSelected(null);
    if (leadParam) setSearchParams({}, { replace: true });
  };
  // won/lost leads leave the board automatically — they live in the Closed view.
  // "Closed", not "Archive": this tab was never `archivedAt`, it is an OUTCOME, and calling it
  // Archive was what made the real Archive screen impossible to reason about (2026-08-03).
  // Archiving a lead is a soft delete and sends it to /archive instead.
  const [view, setView] = useState<"board" | "closed">("board");

  // two queries, two sides of the pipeline: the board never loads the closed list and vice versa.
  // Both stay mounted so the "Closed (N)" count is live without re-fetching on every switch.
  const board = useLeads("in_process");
  const closedList = useLeads("closed");
  const { isLoading, error } = view === "board" ? board : closedList;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const active = useMemo(() => board.data?.items ?? [], [board.data]);
  const closed = closedList.data?.items ?? [];
  const leads = view === "board" ? board.data : closedList.data;

  const byStage = useMemo(() => {
    const map = new Map<LeadStage, Lead[]>(STAGES.map((s) => [s.key, []]));
    for (const lead of active) {
      map.get(lead.stage)?.push(lead);
    }
    return map;
  }, [active]);

  const onDragEnd = (event: DragEndEvent) => {
    const leadId = String(event.active.id);
    const stage = event.over?.id as LeadStage | undefined;
    const lead = active.find((l) => l.id === leadId);
    if (!stage || !lead || lead.stage === stage) return;
    update.mutate({ id: leadId, input: { stage } });
  };

  return (
    // full-bleed screen: white header bar + board on the app background (design)
    <div className="-m-6 flex h-[calc(100vh-3.5rem)] flex-col">
      <div className="flex flex-none items-center gap-3.5 border-b border-border bg-surface px-6 pb-3 pt-4">
        <h1 className="text-[18px] font-semibold">Leads</h1>
        <span className="text-[13px] text-muted-400">
          {leads
            ? view === "board"
              ? `${board.data?.total ?? 0} ${board.data?.total === 1 ? "lead" : "leads"} · sales pipeline`
              : `${closedList.data?.total ?? 0} won or lost`
            : "sales pipeline"}
        </span>
        <div className="ml-auto flex items-center gap-3">
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: "board", label: "Board" },
              { value: "closed", label: `Closed (${closedList.data?.total ?? 0})` },
            ]}
          />
          <Button onClick={() => setFormOpen(true)}>+ New lead</Button>
        </div>
      </div>

      {leads?.truncated && (
        <p className="flex-none bg-[#f7ede2] px-6 py-2 text-[12px] text-[#b5651d]">
          Showing the {leads.items.length} newest of {leads.total} — a pipeline this long usually
          means old leads need closing.
        </p>
      )}
      {isLoading && <p className="p-6 text-[13px] text-muted">Loading…</p>}
      {error && <p className="p-6 text-[13px] text-danger-text">Failed to load leads.</p>}
      {/* a ?lead= that resolves to nothing (deleted / archived / bad id) must say so, and it
          belongs up here with the page's other status lines, not pinned under the board */}
      {leadParam && linked.error && !selected && (
        <p className="flex-none px-6 pb-2 text-[13px] text-danger-text">
          That lead no longer exists.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => setSearchParams({}, { replace: true })}
          >
            Back to the pipeline
          </button>
        </p>
      )}

      {leads && view === "board" && (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <div className="grid flex-1 grid-cols-[repeat(6,minmax(190px,1fr))] items-start gap-3 overflow-auto p-3.5">
            {STAGES.map((stage) => (
              <StageColumn
                key={stage.key}
                stage={stage}
                leads={byStage.get(stage.key) ?? []}
                onOpen={setSelected}
              />
            ))}
          </div>
        </DndContext>
      )}

      {leads && view === "closed" && <ClosedLeads leads={closed} onOpen={setSelected} />}

      {formOpen && <LeadFormModal open={formOpen} onClose={() => setFormOpen(false)} />}
      {selected && <LeadDetails lead={selected} onClose={closeDetails} />}
    </div>
  );
}

/** Won & lost leads — off the board, still reachable from it (reopen / open the client). */
function ClosedLeads({ leads, onOpen }: { leads: Lead[]; onOpen: (lead: Lead) => void }) {
  const { data: settings } = useSettings();
  const { data: services } = useCatalog();

  if (leads.length === 0) {
    return (
      <p className="p-6 text-[13px] text-muted">
        No won or lost leads yet — they land here automatically once the outcome is set.
      </p>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-3.5">
      <div className="overflow-hidden rounded-(--radius-panel) border border-border bg-surface">
        {leads.map((lead) => {
          const service = services?.find((s) => s.id === lead.serviceId);
          const sourceName = settings?.sources.find((s) => s.id === lead.sourceId)?.name;
          const contact = [lead.phone, lead.email].filter(Boolean).join(" · ");
          return (
            <button
              key={lead.id}
              type="button"
              onClick={() => onOpen(lead)}
              className="flex w-full items-center gap-3 border-b border-divider px-4 py-2.5 text-left text-[13px] last:border-0 hover:bg-divider/40"
            >
              <span className="min-w-0 truncate font-semibold">{lead.name}</span>
              <StatusPill status={lead.outcome} />
              {service && <ServiceChip name={service.name} color={service.color} />}
              {sourceName && (
                <Chip tone="gray" size="sm">
                  {sourceName}
                </Chip>
              )}
              <span className="ml-auto truncate text-[12px] text-muted">{contact}</span>
              <span className="flex-none text-[12px] text-muted-400">
                {fmtDate(lead.createdAt)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StageColumn({
  stage,
  leads,
  onOpen,
}: {
  stage: { key: LeadStage; label: string };
  leads: Lead[];
  onOpen: (lead: Lead) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.key });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "min-h-40 rounded-(--radius-panel) p-1",
        isOver && "bg-[#eef1fb] outline-2 outline-dashed outline-primary/40",
      )}
    >
      <div className="flex items-center gap-1.5 px-1 pb-2.5 pt-0.5">
        <span className="text-[12px] font-bold tracking-[.5px] text-ink-700">
          {stage.label}
        </span>
        <span className="rounded-[10px] bg-[#e7eaef] px-[7px] py-px text-[11px] font-semibold text-muted-400">
          {leads.length}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {leads.map((lead) => (
          <LeadCard key={lead.id} lead={lead} onOpen={() => onOpen(lead)} />
        ))}
      </div>
    </div>
  );
}

function LeadCard({ lead, onOpen }: { lead: Lead; onOpen: () => void }) {
  const locked = lead.outcome !== "in_process"; // won or lost — not draggable
  const { data: settings } = useSettings();
  const { data: services } = useCatalog();
  const sourceName = settings?.sources.find((s) => s.id === lead.sourceId)?.name;
  const service = services?.find((s) => s.id === lead.serviceId);

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: lead.id,
    disabled: locked,
  });

  const contact = [lead.phone, lead.email].filter(Boolean).join(" · ");

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={() => !isDragging && onOpen()}
      style={
        transform
          ? { transform: `translate(${transform.x}px, ${transform.y}px)` }
          : undefined
      }
      className={cn(
        "cursor-pointer rounded-[9px] border border-border bg-surface px-3 py-[11px] shadow-(--shadow-card)",
        isDragging && "z-10 opacity-80",
        locked && "opacity-70",
      )}
    >
      <div className="flex items-start justify-between gap-1.5">
        <span className="text-[13px] font-semibold leading-[1.3]">{lead.name}</span>
        {lead.outcome !== "in_process" && <StatusPill status={lead.outcome} />}
      </div>
      {contact && <div className="mt-[3px] truncate text-[12px] text-muted">{contact}</div>}
      {(sourceName || service) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {service && <ServiceChip name={service.name} color={service.color} />}
          {sourceName && (
            <Chip tone="gray" size="sm">
              {sourceName}
            </Chip>
          )}
        </div>
      )}
    </div>
  );
}

function LeadDetails({ lead: initial, onClose }: { lead: Lead; onClose: () => void }) {
  // both lists are already in cache (the page keeps them mounted) — read the lead from whichever
  // holds it now, so Mark lost / Reopen, which move it between them, update the open card
  const { data: board } = useLeads("in_process");
  const { data: closedList } = useLeads("closed");
  const { data: settings } = useSettings();
  const { data: services } = useCatalog();
  const markLost = useMarkLost();
  const reopen = useReopenLead();
  const archiveLead = useArchiveLead();
  const [editOpen, setEditOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);

  const lead =
    [...(board?.items ?? []), ...(closedList?.items ?? [])].find((l) => l.id === initial.id) ??
    initial;
  const locked = lead.outcome === "won";

  if (editOpen) {
    return <LeadFormModal open onClose={() => setEditOpen(false)} lead={lead} />;
  }
  if (convertOpen) {
    return <ConvertLeadModal open lead={lead} onClose={() => setConvertOpen(false)} />;
  }

  const sourceName = settings?.sources.find((s) => s.id === lead.sourceId)?.name;
  const serviceName = services?.find((s) => s.id === lead.serviceId)?.name;
  const stageLabel = STAGES.find((s) => s.key === lead.stage)?.label;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex max-h-[88vh] w-full max-w-[480px] flex-col overflow-hidden rounded-[12px] bg-surface shadow-(--shadow-modal)">
        {/* header */}
        <div className="flex items-start justify-between gap-3 border-b border-[#eef0f3] px-5 py-[18px]">
          <div>
            <h2 className="flex items-center gap-2 text-[17px] font-semibold">
              {lead.name}
              {lead.outcome !== "in_process" && <StatusPill status={lead.outcome} />}
            </h2>
            <div className="mt-0.5 text-[13px] text-muted">Stage: {stageLabel}</div>
          </div>
          <button
            type="button"
            className="text-[13px] text-muted hover:text-ink"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        {/* detail grid */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-3.5 border-b border-[#eef0f3] px-5 py-[18px]">
          <LeadField label="Phone" value={lead.phone} />
          <LeadField label="Email" value={lead.email} />
          <LeadField label="Service" value={serviceName ?? null} />
          <LeadField label="Source" value={sourceName ?? null} />
          <LeadField
            label="Created"
            value={fmtDate(lead.createdAt)}
          />
          <div className="col-span-2">
            <div className="mb-[3px] text-[11px] uppercase tracking-[.4px] text-muted-400">
              Background
            </div>
            <div className="whitespace-pre-wrap text-[13px] leading-normal text-ink-700">
              {lead.description || "—"}
            </div>
          </div>
          {locked && lead.convertedClientId && (
            <div className="col-span-2">
              <Link
                to={`/clients/${lead.convertedClientId}`}
                className="text-[13px] font-medium text-primary-link hover:underline"
              >
                → Open the converted client
              </Link>
            </div>
          )}
        </div>

        {/* tasks for this lead (free internal work) */}
        <div className="min-h-0 flex-1 overflow-y-auto border-b border-[#eef0f3] px-5 py-[18px]">
          <EntityTasks target={{ kind: "lead", id: lead.id, label: lead.name }} />
        </div>

        {/* footer actions */}
        <div className="flex items-center justify-between gap-2 bg-[#fafbfc] px-5 py-3.5">
          <button
            type="button"
            disabled
            title="Available with the Calendar stage (S8)"
            className="rounded-[8px] border border-[#d9dde3] px-4 py-2.5 text-[13px] font-medium text-muted-400"
          >
            📅 Schedule meeting
          </button>
          {!locked && (
            <button
              type="button"
              disabled={archiveLead.isPending}
              onClick={() => {
                if (!window.confirm("Archive this lead? It leaves the pipeline — restorable from Archive.")) return;
                archiveLead.mutate(lead.id, { onSuccess: onClose });
              }}
              className="mr-auto ml-2 text-[13px] font-medium text-muted hover:text-ink-700 hover:underline"
            >
              Archive
            </button>
          )}
          {locked ? (
            <span className="text-[13px] font-semibold text-success">✓ Already a client</span>
          ) : lead.outcome === "lost" ? (
            <span className="flex items-center gap-3">
              <span className="text-[13px] font-semibold text-danger-text">✗ Marked as lost</span>
              <button
                type="button"
                disabled={reopen.isPending}
                onClick={() => reopen.mutate(lead.id)}
                className="text-[13px] font-medium text-primary-link hover:underline"
              >
                Reopen
              </button>
            </span>
          ) : (
            <span className="flex gap-2">
              <button
                type="button"
                onClick={() => setEditOpen(true)}
                className="rounded-[8px] border border-[#d9dde3] px-4 py-2.5 text-[13px] font-medium text-ink-700 hover:bg-divider"
              >
                Edit
              </button>
              <button
                type="button"
                disabled={markLost.isPending}
                onClick={() => markLost.mutate(lead.id)}
                className="rounded-[8px] border border-[#e6c3c3] px-4 py-2.5 text-[13px] font-semibold text-danger-text hover:bg-danger-soft"
              >
                ✗ Mark as lost
              </button>
              <button
                type="button"
                onClick={() => setConvertOpen(true)}
                className="rounded-[8px] bg-success px-[18px] py-2.5 text-[13px] font-semibold text-white hover:opacity-90"
              >
                → Convert to client
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function LeadField({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <div className="mb-[3px] text-[11px] uppercase tracking-[.4px] text-muted-400">
        {label}
      </div>
      <div className="text-[13px] text-ink-700">{value || "—"}</div>
    </div>
  );
}
