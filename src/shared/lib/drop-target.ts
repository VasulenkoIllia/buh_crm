/**
 * Where a dropped item lands, worked out on ids alone — no React, no dnd-kit.
 *
 * Shared because the question is the same wherever something is dragged into an order: the kanban
 * board, and the service catalog. Only the NAMES differ at the call sites, so they are neutral
 * here — a "list" is a board column or a whole catalog, and the answer is always a neighbour.
 *
 * Its own module because the first version lived inside the board's `onDragEnd` and was wrong in a
 * way nothing could see: `over` is a CARD when the pointer is on one and the COLUMN when it is on
 * the empty space below, and only the first case was handled. `ids.indexOf(columnId)` is `-1`, and
 * `arrayMove` with `-1` does something arbitrary — with two cards it returns the list unchanged, so
 * the drag simply did nothing; with three it threw the card to the end. Two cards is where it shows,
 * because a short column is mostly empty space and the column wins the collision more often
 * (user, 2026-08-27).
 */

export interface DropTarget {
  /** the list the item landed in — a kanban column, or the single list of a plain sortable */
  listId: string;
  /** the item to land behind; `null` = the top of the list */
  afterId: string | null;
}

/**
 * `lists` is the board as drawn: column id → the ids in it, top to bottom. `overId` is whatever
 * dnd-kit reported — a card id or a column id.
 *
 * Returns `null` for every drop that must NOT be written: nothing under the pointer, a card on
 * itself, an unknown target, or a move that leaves the order exactly as it was.
 */
export function resolveDrop(
  lists: Map<string, string[]>,
  activeId: string,
  overId: string | null,
): DropTarget | null {
  if (!overId || overId === activeId) return null;

  const columnOf = (id: string): string | null => {
    for (const [column, ids] of lists) if (ids.includes(id)) return column;
    return null;
  };

  const from = columnOf(activeId);
  if (!from) return null;

  // a column id means the empty space below the cards; anything else must be a card on the board
  const droppedOnColumn = lists.has(overId);
  const to = droppedOnColumn ? overId : columnOf(overId);
  if (!to) return null;

  const source = lists.get(from) ?? [];
  const target = (lists.get(to) ?? []).filter((id) => id !== activeId);

  let at: number;
  if (droppedOnColumn) {
    at = target.length; // below the last card
  } else {
    const overAt = target.indexOf(overId);
    if (overAt === -1) return null;
    // Within one column, a card dragged DOWN onto another lands after it, and one dragged UP lands
    // before it — which is what the eye expects and what the placeholder showed during the drag.
    // Coming from another column it simply takes the place of the card it was dropped on.
    const movedDown = from === to && source.indexOf(activeId) < (lists.get(to) ?? []).indexOf(overId);
    at = movedDown ? overAt + 1 : overAt;
  }

  const afterId = at === 0 ? null : (target[at - 1] ?? null);

  // dropped back where it started — a drag that changes nothing must not write anything
  if (from === to) {
    const wasAt = source.indexOf(activeId);
    if ((wasAt === 0 ? null : source[wasAt - 1]) === afterId) return null;
  }
  return { listId: to, afterId };
}

/**
 * The list as it will be once the drop lands — the client's mirror of the server's renumber.
 *
 * Both an optimistic reorder and the server's own `splice(at + 1, 0, id)` have to agree, and the
 * same five lines had been written twice on the client already (the board and the catalog). Two
 * copies of an arithmetic that must match a third is how they stop matching.
 *
 * An unknown `afterId` puts the item first, which is what `resolveDrop` and both server paths do
 * with an anchor that is no longer there.
 */
export function applyDrop<T>(
  items: T[],
  id: string,
  afterId: string | null,
  idOf: (item: T) => string,
): T[] {
  const moving = items.find((i) => idOf(i) === id);
  if (!moving) return items;
  const rest = items.filter((i) => idOf(i) !== id);
  const at = afterId ? rest.findIndex((i) => idOf(i) === afterId) : -1;
  rest.splice(at + 1, 0, moving);
  return rest;
}
