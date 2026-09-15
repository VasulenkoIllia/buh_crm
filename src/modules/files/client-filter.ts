/**
 * **Finding a client in a list as it is typed** (files.md §13): any part of the name, or the code
 * typed as "142", "#142", "C-142" or "C–142", its start being enough.
 */
export function matchesClient(client: { label: string; code: number }, typed: string): boolean {
  const q = typed.trim().normalize("NFC").toLowerCase();
  if (!q) return true;
  if (client.label.normalize("NFC").toLowerCase().includes(q)) return true;
  const digits = q.replace(/^#?\s*(?:c\s*[-–]?)?\s*/, "");
  return /^\d+$/.test(digits) && String(client.code).startsWith(String(Number(digits)));
}
