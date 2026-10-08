import { useEffect, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, X } from "lucide-react";
import { MAX_STAGES, STAGE_NAME_MAX, type Service } from "@shared/schema/catalog";
import { cn } from "@/shared/lib/cn";
import { Button, IconButton } from "@/shared/ui/button";
import { Input, Label, Select } from "@/shared/ui/field";
import { InfoHint } from "@/shared/ui/info-hint";
import {
  NAMELESS_STAGE,
  type StageRow,
  addRow,
  copyRows,
  moveRow,
  stageProblems,
} from "./stages";

/**
 * A service's stages, edited with the service (owner, 2026-10-08): an ordered list of steps its
 * tasks go through, saved whole with the rest of the form. Empty is the ordinary case and changes
 * nothing anywhere.
 *
 * A new list can start as a copy of another service's: Personal and Business tax returns go
 * through the same steps, and typing eight names twice is how the two would drift apart. The copy
 * is only offered while the list is empty, because replacing a list whose stages tasks stand on is
 * a removal the server would refuse.
 *
 * The rows are dragged by their handle, the way the services list itself is (owner, 2026-10-08):
 * the first version moved them with ↑/↓ buttons, one place per click.
 */
export function StagesEditor({
  rows,
  onChange,
  others,
  showEmpty,
}: {
  rows: StageRow[];
  onChange: (rows: StageRow[]) => void;
  /** other services that have stages, to copy from */
  others: Service[];
  /**
   * Mark a nameless row too. Off until a save meets one: a row just added is empty because it is
   * about to be typed into, and it lit up red before a key was pressed (review, 2026-10-08).
   */
  showEmpty: boolean;
}) {
  const problems = new Map(
    [...stageProblems(rows)].filter(([, problem]) => showEmpty || problem !== NAMELESS_STAGE),
  );
  const rename = (key: string, name: string) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, name } : r)));
  // A new row takes the cursor. Without it the typing went wherever the focus was, which on a
  // freshly opened form is the service's NAME, and an Enter there saved the renamed service
  // (found testing, 2026-10-08).
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const add = () => {
    const next = addRow(rows);
    if (next !== rows) setFocusKey(next[next.length - 1].key);
    onChange(next);
  };

  // the same sensors as the services list: a press that moves less than 6px is still a click, and
  // the handle answers the keyboard too (Space lifts, arrows move, Space drops, Escape cancels)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  // Escape during a drag cancels the drag and must not close the form around it. The keyboard sensor
  // marks the key handled, the pointer sensor does not, so while anything is lifted the key is marked
  // here, on the way DOWN (capture), before the modal's listener sees it on the way back up. The
  // sensor still gets it and cancels (review, 2026-10-08).
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    const claim = (e: KeyboardEvent) => e.key === "Escape" && e.preventDefault();
    window.addEventListener("keydown", claim, true);
    return () => window.removeEventListener("keydown", claim, true);
  }, [dragging]);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(false);
    if (!over) return;
    const from = rows.findIndex((r) => r.key === active.id);
    const to = rows.findIndex((r) => r.key === over.id);
    onChange(moveRow(rows, from, to));
  };

  const empty = rows.length === 0;
  // "+ Add stage", and while the list is empty, a copy of another service's list
  const ways = (
    <>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={rows.length >= MAX_STAGES}
        onClick={add}
      >
        + Add stage
      </Button>
      {empty && others.length > 0 && (
        <Select
          className="h-8 w-auto max-w-[260px] text-[13px]"
          aria-label="Copy the stages of another service"
          value=""
          onChange={(e) => {
            const from = others.find((s) => s.id === e.target.value);
            if (from) onChange(copyRows(from.stages));
          }}
        >
          <option value="">Copy from another service…</option>
          {others.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.stages.length})
            </option>
          ))}
        </Select>
      )}
    </>
  );

  return (
    <div className="rounded-[10px] border border-[#e6e9ee] p-3.5">
      {/* Empty, which is most services, it is one line: the label and its two ways in. As a label
          over a button it took 86px, and a subscription's form, which filled a 13-inch MacBook's
          window exactly, scrolled by 14px for a box nobody had used (2026-10-08). */}
      <div className={cn("flex flex-wrap items-center gap-2", empty && "[&>label]:mb-0")}>
        <Label>
          Stages <span className="font-normal text-faint">optional</span>{" "}
          <InfoHint label="What stages do">
            The steps this service&apos;s work goes through, in order. Its tasks get a Stage
            field, and the tasks table can sort and filter by it. A stage that tasks stand on
            can be renamed or moved, but not removed.
          </InfoHint>
        </Label>
        {empty && <div className="ml-auto flex flex-wrap items-center gap-2">{ways}</div>}
      </div>

      {!empty && (
        <>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={() => setDragging(true)}
            onDragEnd={onDragEnd}
            onDragCancel={() => setDragging(false)}
          >
            <SortableContext
              items={rows.map((r) => r.key)}
              strategy={verticalListSortingStrategy}
            >
              <ol className="mb-2 space-y-1.5">
                {rows.map((row, i) => (
                  <SortableStage
                    key={row.key}
                    id={row.key}
                    name={row.name.trim() || `stage ${i + 1}`}
                    canDrag={rows.length > 1}
                  >
                    <span className="w-5 flex-none text-right text-[12px] tabular-nums text-faint">
                      {i + 1}
                    </span>
                    <Input
                      className="h-8 flex-1 text-[13px]"
                      value={row.name}
                      autoFocus={row.key === focusKey}
                      maxLength={STAGE_NAME_MAX}
                      aria-label={`Stage ${i + 1}`}
                      placeholder="e.g. Docs Received"
                      error={problems.has(row.key)}
                      onChange={(e) => rename(row.key, e.target.value)}
                      onKeyDown={(e) => {
                        // Enter adds the next stage instead of submitting the whole form
                        if (e.key === "Enter") {
                          e.preventDefault();
                          if (i === rows.length - 1 && row.name.trim()) add();
                        }
                      }}
                    />
                    <IconButton
                      label="Remove stage"
                      size="sm"
                      danger
                      onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
                    >
                      <X />
                    </IconButton>
                    {problems.has(row.key) && (
                      <p className="basis-full pl-[52px] text-[12px] text-danger-text">
                        {problems.get(row.key)}
                      </p>
                    )}
                  </SortableStage>
                ))}
              </ol>
            </SortableContext>
          </DndContext>
          {ways}
        </>
      )}
    </div>
  );
}

/**
 * One row, dragged by its handle only: the rest of the row is a text box, and a drag starting in
 * it would fight selecting the text typed there. A list of one has nothing to reorder, so its
 * handle is not drawn, and its place is kept so the row does not shift when a second one arrives.
 */
function SortableStage({
  id,
  name,
  canDrag,
  children,
}: {
  id: string;
  /** says WHICH row the handle moves: twenty handles all called "Drag to reorder" are one */
  name: string;
  canDrag: boolean;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: !canDrag,
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "relative flex flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-md bg-surface",
        isDragging && "z-10 opacity-80 shadow-md",
      )}
    >
      {canDrag ? (
        <IconButton
          label={`Drag to reorder: ${name}`}
          size="sm"
          {...attributes}
          {...listeners}
          // touch-none: on a touch screen the finger drags the row instead of scrolling the form
          className="w-5 cursor-grab touch-none text-faint active:cursor-grabbing"
        >
          <GripVertical />
        </IconButton>
      ) : (
        <span className="w-5 flex-none" />
      )}
      {children}
    </li>
  );
}
