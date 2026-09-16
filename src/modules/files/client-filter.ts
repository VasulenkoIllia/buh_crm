/**
 * **Finding a client in a list as it is typed** (files.md §13), by the search box's rule: every
 * word somewhere in the name, in any order, or the code typed as "142", "#142", "C-142" or
 * "C 142", its start being enough.
 */
export function matchesClient(client: { label: string; code: number }, typed: string): boolean {
  const q = typed.trim().normalize("NFC").toLowerCase();
  if (!q) return true;
  const label = client.label.normalize("NFC").toLowerCase();
  const code = String(client.code);
  const codeStarts = (text: string) => {
    const digits = text.replace(/^#?\s*(?:c\s*[-–]?)?\s*/, "");
    return /^\d+$/.test(digits) && code.startsWith(String(Number(digits)));
  };
  return codeStarts(q) || q.split(/\s+/).every((w) => label.includes(w) || codeStarts(w));
}
