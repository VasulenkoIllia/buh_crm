/**
 * Escape a value before interpolating it into HTML.
 *
 * Lives on its own because two senders need it — the built-in transactional templates in
 * `email.ts` and the mailout shell in `email-layout.ts` — and a second copy is how the two would
 * eventually come to disagree about what is safe.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
