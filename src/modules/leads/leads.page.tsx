import { useMemo, useState } from "react";
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { Link } from "react-router-dom";
import type { LeadStage } from "@shared/schema/enums";
import type { Lead } from "@shared/schema/lead";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { StatusPill } from "@/shared/ui/pill";
import { useCatalog } from "@/modules/catalog";
import { useSettings } from "@/modules/settings";
import { ConvertLeadModal, LeadFormModal } from "./lead-modals";
import { useLeads, useMarkLost, useReopenLead, useUpdateLead } from "./leads.api";

const STAGES: Array<{ key: LeadStage; label: string }> = [
  { key: "first_contact", label: "First contact" },
  { key: "no_answer", label: "No answer" },
  { key: "set_up_meeting", label: "Set up meeting" },
  { key: "thinking", label: "Thinking" },
  { key: "on_hold", label: "On hold" },
  { key: "next_time", label: "Next time" },
];

export function LeadsPage() {
  const { data: leads, isLoading, error } = useLeads();
  const update = useUpdateLead();
  const [formOpen, setFormOpen] = useState(false);
  const [selected, setSelected] = useState<Lead | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const byStage = useMemo(() => {
    const map = new Map<LeadStage, Lead[]>(STAGES.map((s) => [s.key, []]));
    for (const lead of leads ?? []) {
      map.get(lead.stage)?.push(lead);
    }
    return map;
  }, [leads]);

  const onDragEnd = (event: DragEndEvent) => {
    const leadId = String(event.active.id);
    const stage = event.over?.id as LeadStage | undefined;
    const lead = leads?.find((l) => l.id === leadId);
    if (!stage || !lead || lead.stage === stage) return;
    update.mutate({ id: leadId, input: { stage } });
  };

  return (
    // full-bleed screen: white header bar + board on the app background (design)
    <div className="-m-6 flex h-[calc(100vh-3.5rem)] flex-col">
      <div className="flex flex-none items-center gap-3.5 border-b border-border bg-surface px-6 pb-3 pt-4">
        <h1 className="text-[18px] font-semibold">Leads</h1>
        <span className="text-[13px] text-muted-400">
          {leads ? `${leads.length} ${leads.length === 1 ? "lead" : "leads"} · ` : ""}
          sales pipeline
        </span>
        <Button className="ml-auto" onClick={() => setFormOpen(true)}>
          + New lead
        </Button>
      </div>

      {isLoading && <p className="p-6 text-[13px] text-muted">Loading…</p>}
      {error && <p className="p-6 text-[13px] text-danger-text">Failed to load leads.</p>}

      {leads && (
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

      {formOpen && <LeadFormModal open={formOpen} onClose={() => setFormOpen(false)} />}
      {selected && <LeadDetails lead={selected} onClose={() => setSelected(null)} />}
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
  const sourceName = settings?.sources.find((s) => s.id === lead.sourceId)?.name;

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
      {sourceName && (
        <div className="mt-2 flex items-center gap-1.5">
          <span className="rounded-(--radius-chip) bg-[#eef0f3] px-[7px] py-[2px] text-[11px] text-muted">
            {sourceName}
          </span>
        </div>
      )}
    </div>
  );
}

function LeadDetails({ lead: initial, onClose }: { lead: Lead; onClose: () => void }) {
  const { data: leads } = useLeads();
  const { data: settings } = useSettings();
  const { data: services } = useCatalog();
  const markLost = useMarkLost();
  const reopen = useReopenLead();
  const [editOpen, setEditOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);

  const lead = leads?.find((l) => l.id === initial.id) ?? initial;
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
      <div className="w-full max-w-[480px] overflow-hidden rounded-[12px] bg-surface shadow-(--shadow-modal)">
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
            value={new Date(lead.createdAt).toLocaleDateString("en-GB")}
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
