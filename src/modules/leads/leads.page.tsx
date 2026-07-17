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
import { Mail, Phone } from "lucide-react";
import type { LeadStage } from "@shared/schema/enums";
import type { Lead } from "@shared/schema/lead";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { StatusPill } from "@/shared/ui/pill";
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

  if (isLoading) return <p className="text-[13px] text-muted">Loading…</p>;
  if (error) return <p className="text-[13px] text-danger-text">Failed to load leads.</p>;

  return (
    <div className="flex h-full flex-col">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-[20px] font-semibold">Leads</h1>
        <Button onClick={() => setFormOpen(true)}>New lead</Button>
      </div>

      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="flex flex-1 gap-3 overflow-x-auto pb-2">
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

      {formOpen && <LeadFormModal open={formOpen} onClose={() => setFormOpen(false)} />}
      {selected && (
        <LeadDetails lead={selected} onClose={() => setSelected(null)} />
      )}
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
        "flex w-60 shrink-0 flex-col rounded-(--radius-panel) border border-border bg-[#f5f6f8] p-2",
        isOver && "border-primary bg-[#eef1fb]",
      )}
    >
      <div className="mb-2 flex items-center justify-between px-1.5 pt-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-400">
          {stage.label}
        </span>
        <span className="text-[11px] text-muted">{leads.length}</span>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto">
        {leads.map((lead) => (
          <LeadCard key={lead.id} lead={lead} onOpen={() => onOpen(lead)} />
        ))}
      </div>
    </div>
  );
}

function LeadCard({ lead, onOpen }: { lead: Lead; onOpen: () => void }) {
  const locked = lead.outcome === "won";
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: lead.id,
    disabled: locked,
  });

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
        "cursor-pointer rounded-(--radius-card) border border-border bg-surface p-2.5 shadow-(--shadow-card)",
        isDragging && "z-10 opacity-80",
        locked && "opacity-70",
      )}
    >
      <div className="flex items-start justify-between gap-1.5">
        <span className="text-[13px] font-medium">{lead.name}</span>
        {lead.outcome !== "in_process" && <StatusPill status={lead.outcome} />}
      </div>
      <div className="mt-1.5 space-y-0.5 text-[12px] text-muted">
        {lead.phone && (
          <div className="flex items-center gap-1">
            <Phone size={11} /> {lead.phone}
          </div>
        )}
        {lead.email && (
          <div className="flex items-center gap-1">
            <Mail size={11} /> {lead.email}
          </div>
        )}
      </div>
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
