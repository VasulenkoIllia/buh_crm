/**
 * **A place is a value, not a row** (secrets.md §4.1). Three of them, fixed, drawn by this screen:
 * My secrets, Company, and one list per client. There are no folders, so there is no tree to walk
 * and nothing to rename, empty or lose.
 */
export type UiPlace =
  { kind: "my" } | { kind: "company" } | { kind: "client"; clientId: string };

export const MY: UiPlace = { kind: "my" };
export const COMPANY: UiPlace = { kind: "company" };

/** What the right-hand pane shows. `focus` marks a secret arrived at from a search result (§10). */
export type View =
  | { type: "place"; place: UiPlace; focus?: string }
  /** every client, one row each, with how many secrets it holds */
  | { type: "clients" }
  | { type: "trash" };

/** The path a place's routes sit under: `/api/secrets/my`, `/company`, `/clients/<id>`. */
export const placePath = (place: UiPlace) =>
  place.kind === "my"
    ? "my"
    : place.kind === "company"
      ? "company"
      : `clients/${place.clientId}`;

export const samePlace = (a: UiPlace, b: UiPlace) =>
  a.kind === b.kind &&
  (a.kind !== "client" || a.clientId === (b as { clientId: string }).clientId);

export const viewKey = (view: View) =>
  view.type === "place" ? `place:${placePath(view.place)}` : view.type;
