import { useMemo, useState } from "react";
import {
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { resolveDrop } from "./drop-target";

/**
 * Everything a kanban board needs to be dragged, worked out once.
 *
 * The tasks board earned all of this the hard way — the two-card bug, columns landing a place from
 * where they were dropped, a target column that opened no gap, a settle that read as jumping. None
 * of it is obvious and all of it is the same on any board, so the leads board takes it rather than
 * learning it again.
 *
 * What each board still owns: how a card LOOKS, what its lists mean, and what to do when one lands.
 */

/** every sortable says which of the two things it is; nothing here guesses from the id */
export const DRAG_CARD = "card";
export const DRAG_COLUMN = "column";

export interface BoardDrag<T> {
  sensors: ReturnType<typeof useSensors>;
  collisionDetection: CollisionDetection;
  handlers: {
    onDragStart: (event: DragStartEvent) => void;
    onDragOver: (event: DragOverEvent) => void;
    onDragEnd: (event: DragEndEvent) => void;
    onDragCancel: () => void;
  };
  /** the card in hand, for a `DragOverlay` — null when nothing is being carried */
  carried: T | null;
  /** what a column should render: the preview mid-drag, the real list otherwise */
  shownIn: (listId: string) => T[];
}

export function useBoardDrag<T>({
  lists,
  idOf,
  onMoveCard,
  columnIds,
  onMoveColumn,
}: {
  /** list id → the cards in it, in board order */
  lists: Map<string, T[]>;
  idOf: (item: T) => string;
  /** a card landed: which list it is in now, and which card it sits behind (null = the top) */
  onMoveCard: (item: T, to: { listId: string; afterId: string | null }) => void;
  /** pass these to make the COLUMNS draggable as well; omit and only cards move */
  columnIds?: string[];
  onMoveColumn?: (id: string, afterId: string | null) => void;
}): BoardDrag<T> {
  const [carriedId, setCarriedId] = useState<string | null>(null);
  /**
   * The board as it looks WHILE a card is crossing it: list id → card ids.
   *
   * Null except during a cross-list drag. Each column is its own `SortableContext`, so a card that
   * has left column A is in nobody's `items` and no list has anything to shift — the target opened
   * no gap and the board sat still. Moving the id between these lists as the pointer crosses puts
   * the card in the target's context, and dnd-kit does the rest.
   *
   * A PREVIEW and nothing else, thrown away the moment the drag ends.
   */
  const [preview, setPreview] = useState<Map<string, string[]> | null>(null);

  // the card is focusable, so without the keyboard sensor it is a tab stop that answers nothing
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const byId = useMemo(() => {
    const map = new Map<string, T>();
    for (const items of lists.values()) for (const item of items) map.set(idOf(item), item);
    return map;
  }, [lists, idOf]);

  const shownIn = (listId: string): T[] =>
    preview
      ? (preview.get(listId) ?? []).flatMap((id) => byId.get(id) ?? [])
      : (lists.get(listId) ?? []);

  /**
   * Cards win over the column they sit in.
   *
   * Both are droppable — the column so a card can land on the empty space below, and in a column
   * that holds none. With `closestCenter` alone the column's centre can be nearer than a card's,
   * and a SHORT column is mostly empty space: with two cards the column kept winning while the
   * pointer was plainly on a card, which is what "it lags with two cards" was.
   *
   * A COLUMN being dragged is read by the POINTER instead. `closestCenter` measures from the middle
   * of the thing being dragged, and a column is 230px of it; with the neighbours already shifted
   * aside that midpoint is nowhere near the cursor — released over one column it reported the next
   * one along.
   */
  const collisionDetection: CollisionDetection = (args) => {
    if (args.active.data.current?.type === DRAG_COLUMN) {
      const onlyColumns = {
        ...args,
        droppableContainers: args.droppableContainers.filter((c) => lists.has(String(c.id))),
      };
      const under = pointerWithin(onlyColumns);
      return under.length > 0 ? under : closestCenter(onlyColumns);
    }
    const within = pointerWithin(args);
    const onCard = within.filter((c) => !lists.has(String(c.id)));
    if (onCard.length > 0) return onCard;
    return within.length > 0 ? within : closestCenter(args);
  };

  /** carry the id between lists as the pointer crosses; within one list dnd-kit already shifts it */
  const onDragOver = (event: DragOverEvent) => {
    if (event.active.data.current?.type !== DRAG_CARD || !event.over) return;
    const activeId = String(event.active.id);
    const overId = String(event.over.id);
    setPreview((current) => {
      const base =
        current ?? new Map([...lists].map(([c, items]) => [c, items.map(idOf)] as const));
      const from = [...base].find(([, ids]) => ids.includes(activeId))?.[0];
      // `over` is a column when the pointer is on its empty space, a card when it is on one
      const to = base.has(overId) ? overId : [...base].find(([, ids]) => ids.includes(overId))?.[0];
      if (!from || !to || from === to) return current;
      const next = new Map([...base].map(([c, ids]) => [c, ids.filter((id) => id !== activeId)]));
      const landing = [...(next.get(to) ?? [])];
      landing.splice(
        base.has(overId) ? landing.length : Math.max(0, landing.indexOf(overId)),
        0,
        activeId,
      );
      next.set(to, landing);
      return next;
    });
  };

  const onDragEnd = (event: DragEndEvent) => {
    const activePreview = preview;
    setCarriedId(null);
    setPreview(null);

    if (event.active.data.current?.type === DRAG_COLUMN) {
      if (!columnIds || !onMoveColumn) return;
      const id = String(event.active.id);
      const target = resolveDrop(
        new Map([["board", columnIds]]),
        id,
        event.over ? String(event.over.id) : null,
      );
      if (target) onMoveColumn(id, target.afterId);
      return;
    }

    const cardId = String(event.active.id);
    const card = byId.get(cardId);
    /**
     * With a preview open the answer is already on the screen. Asking `resolveDrop` again would be
     * worse than redundant: the card is drawn under the cursor by then, so `over` is the card
     * ITSELF, which it correctly refuses — and the drop did nothing at all.
     */
    const target = activePreview
      ? (() => {
          const to = [...activePreview].find(([, ids]) => ids.includes(cardId))?.[0];
          if (!to) return null;
          const ids = activePreview.get(to) ?? [];
          const at = ids.indexOf(cardId);
          return { listId: to, afterId: at <= 0 ? null : (ids[at - 1] ?? null) };
        })()
      : resolveDrop(
          new Map([...lists].map(([c, items]) => [c, items.map(idOf)])),
          cardId,
          event.over ? String(event.over.id) : null,
        );
    if (target && card) onMoveCard(card, target);
  };

  return {
    sensors,
    collisionDetection,
    handlers: {
      onDragStart: ({ active }: DragStartEvent) => {
        // only cards are carried by a DragOverlay: a column moves visibly on its own, and a 230px
        // block following the cursor is the opposite of calm
        if (active.data.current?.type !== DRAG_COLUMN) setCarriedId(String(active.id));
      },
      onDragOver,
      onDragEnd,
      onDragCancel: () => {
        setCarriedId(null);
        setPreview(null);
      },
    },
    carried: carriedId ? (byId.get(carriedId) ?? null) : null,
    shownIn,
  };
}
