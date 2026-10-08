import type { Service } from "@shared/schema/catalog";

/**
 * The stage names the tasks screen's filter offers (owner, 2026-10-08).
 *
 * Each service keeps its own list, so a filter of stage IDS would be one service's at a time. It is
 * by NAME instead, compared ignoring case as the server does: "Docs Received" on both tax returns
 * is one entry that finds both. With a service picked, only that service's stages, in its order;
 * otherwise every service's, each name once, earliest position first. Inactive services count:
 * their open work still shows its stage, and a name nobody can pick is work nobody can find
 * (review, 2026-10-08).
 */
export function stageFilterNames(services: Service[], serviceId?: string): string[] {
  if (serviceId === "none") return []; // internal work goes through no service, so has no stages
  const pool = serviceId ? services.filter((s) => s.id === serviceId) : services;
  const byName = new Map<string, { name: string; order: number }>();
  for (const service of pool) {
    for (const stage of service.stages) {
      const key = stage.name.trim().toLowerCase();
      const seen = byName.get(key);
      if (!seen || stage.order < seen.order) {
        byName.set(key, { name: seen?.name ?? stage.name, order: stage.order });
      }
    }
  }
  return [...byName.values()]
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .map((s) => s.name);
}

export type StageSort = "none" | "asc" | "desc";

/** The Stage header's click: ascending, then descending, then back to the ordinary order. */
export const nextStageSort = (sort: StageSort): StageSort =>
  sort === "none" ? "asc" : sort === "asc" ? "desc" : "none";

/** Whether the firm uses stages at all: until a service has some, the tasks screens show none. */
export const anyStages = (services: Service[]) => services.some((s) => s.stages.length > 0);
