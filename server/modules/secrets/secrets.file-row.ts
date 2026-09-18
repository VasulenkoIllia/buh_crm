import type { SecretFileRow } from "@shared/schema/secrets.js";
import { viewOf } from "../files/index.js";

/**
 * What a list, a search hit and the entry's window show of a secret's file (secrets.md §21): open
 * facts, and how the CRM would show it. Its own file, because the list, the search and the files'
 * own service all need it and must not import each other for it.
 */
export const fileRowOf = (f: {
  id: string;
  name: string;
  size: number;
  detectedMime: string | null;
  createdAt: Date;
}): SecretFileRow => ({
  id: f.id,
  name: f.name,
  size: f.size,
  view: viewOf(f.detectedMime),
  createdAt: f.createdAt.toISOString(),
});
