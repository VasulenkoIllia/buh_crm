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
  const locked = lead.outcome === "won";
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
  const lead = leads?.find((l) => l.id === initial.id) ?? initial;
  const markLost = useMarkLost();
  const reopen = useReopenLead();
  const [editOpen, setEditOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);

  const locked = lead.outcome === "won";

  if (editOpen) {
    return <LeadFormModal open onClose={() => setEditOpen(false)} lead={lead} />;
  }
  if (convertOpen) {
    return <ConvertLeadModal open lead={lead} onClose={() => setConvertOpen(false)} />;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-md rounded-(--radius-panel) bg-surface p-5 shadow-(--shadow-modal)">
        <div className="flex items-start justify-between">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold">
            {lead.name}
            {lead.outcome !== "in_process" && <StatusPill status={lead.outcome} />}
          </h2>
          <button
            type="button"
            className="text-[13px] text-muted hover:text-ink"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <div className="mt-3 space-y-1 text-[13px] text-ink-700">
          {lead.phone && <p>Phone: {lead.phone}</p>}
          {lead.email && <p>Email: {lead.email}</p>}
          {lead.description && <p className="whitespace-pre-wrap">{lead.description}</p>}
          <p className="text-[12px] text-muted">
            Stage: {STAGES.find((s) => s.key === lead.stage)?.label} · Created{" "}
            {new Date(lead.createdAt).toLocaleDateString("en-US")}
          </p>
          {locked && lead.convertedClientId && (
            <p>
              Converted —{" "}
              <Link
                to={`/clients/${lead.convertedClientId}`}
                className="text-primary-link hover:underline"
              >
                open the client
              </Link>
            </p>
          )}
        </div>
        {!locked && (
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            {lead.outcome === "lost" ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={reopen.isPending}
                onClick={() => reopen.mutate(lead.id)}
              >
                Reopen
              </Button>
            ) : (
              <Button
                variant="destructive"
                size="sm"
                disabled={markLost.isPending}
                onClick={() => markLost.mutate(lead.id)}
              >
                Mark lost
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={() => setEditOpen(true)}>
              Edit
            </Button>
            <Button variant="positive" size="sm" onClick={() => setConvertOpen(true)}>
              Move to client
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
