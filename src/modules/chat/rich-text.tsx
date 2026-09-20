import { Fragment, type ReactNode } from "react";

/**
 * **A message's light formatting, rendered by the CRM from its own parser, never as HTML**
 * (chat.md §5.1, decision 13). What a person types is marks: `**bold**`, `_italic_`, `~~struck~~`,
 * `` `code` ``, a fenced block, `> quoted`, and a plain link.
 *
 * It builds React nodes, so nothing a colleague writes can become markup: there is no
 * `dangerouslySetInnerHTML` anywhere in this file, and a `<script>` typed into a message is text
 * like any other.
 */

export interface Block {
  kind: "text" | "quote" | "code";
  lines: string[];
}

/** Lines into blocks: fenced code, quoted runs, and everything else. */
export function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  let fenced: string[] | null = null;
  for (const line of text.split("\n")) {
    if (line.trimEnd() === "```") {
      if (fenced) {
        blocks.push({ kind: "code", lines: fenced });
        fenced = null;
      } else {
        fenced = [];
      }
      continue;
    }
    if (fenced) {
      fenced.push(line);
      continue;
    }
    const quoted = line.startsWith("> ") || line === ">";
    const body = quoted ? line.replace(/^>\s?/, "") : line;
    const kind = quoted ? "quote" : "text";
    const last = blocks.at(-1);
    if (last && last.kind === kind) last.lines.push(body);
    else blocks.push({ kind, lines: [body] });
  }
  // a fence nobody closed is still code: better than showing the ``` as words
  if (fenced) blocks.push({ kind: "code", lines: fenced });
  return blocks;
}

const LINK = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?]/g;

/** `**bold**`, `_italic_`, `~~struck~~`, `` `code` ``, and bare links. Innermost first. */
const MARKS: { pattern: RegExp; wrap: (inner: ReactNode, key: string) => ReactNode }[] = [
  {
    pattern: /`([^`\n]+)`/g,
    wrap: (inner, key) => (
      <code key={key} className="rounded bg-divider px-1 py-0.5 text-[12px]">
        {inner}
      </code>
    ),
  },
  { pattern: /\*\*([^*\n]+)\*\*/g, wrap: (inner, key) => <strong key={key}>{inner}</strong> },
  { pattern: /~~([^~\n]+)~~/g, wrap: (inner, key) => <s key={key}>{inner}</s> },
  { pattern: /_([^_\n]+)_/g, wrap: (inner, key) => <em key={key}>{inner}</em> },
];

/**
 * A link's colour depends on what it is standing on: the reader's own bubble is the primary colour,
 * and a primary link on it is very nearly invisible (found in use, 2026-09-20).
 */
function linkify(text: string, key: string, mine = false): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(LINK)) {
    const start = match.index;
    if (start > at) out.push(text.slice(at, start));
    out.push(
      <a
        key={`${key}-${start}`}
        href={match[0]}
        target="_blank"
        rel="noreferrer noopener"
        className={
          mine
            ? "underline decoration-white/60 hover:decoration-white"
            : "text-primary-link hover:underline"
        }
      >
        {match[0]}
      </a>,
    );
    at = start + match[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function inline(text: string, key: string, depth = 0, mine = false): ReactNode[] {
  if (depth >= MARKS.length) return linkify(text, key, mine);
  const { pattern, wrap } = MARKS[depth];
  const out: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(new RegExp(pattern))) {
    const start = match.index;
    if (start > at) {
      out.push(...inline(text.slice(at, start), `${key}-${at}`, depth + 1, mine));
    }
    // code holds no other marks: what is inside it is what was typed
    const inner =
      depth === 0 ? match[1] : inline(match[1], `${key}-${start}i`, depth + 1, mine);
    out.push(wrap(inner, `${key}-${start}`));
    at = start + match[0].length;
  }
  if (at < text.length) out.push(...inline(text.slice(at), `${key}-${at}`, depth + 1, mine));
  return out;
}

/**
 * **A name after `@` is marked** when it is somebody in this chat, or `@all` (§5.2). Matched
 * against the chat's own people rather than by shape, so an email address or a price in a message
 * is left alone.
 */
function withMentions(nodes: ReactNode[], names: readonly string[], key: string): ReactNode[] {
  if (names.length === 0) return nodes;
  const pattern = new RegExp(
    `@(${[...names]
      .sort((a, b) => b.length - a.length)
      .map(escape)
      .join("|")})\\b`,
    "g",
  );
  return nodes.flatMap((node, i) => {
    if (typeof node !== "string") return [node];
    const out: ReactNode[] = [];
    let at = 0;
    for (const match of node.matchAll(pattern)) {
      const start = match.index;
      if (start > at) out.push(node.slice(at, start));
      out.push(
        <span
          key={`${key}-${i}-${start}`}
          // the colour is the bubble's: a link blue is unreadable inside one's own message
          className="font-semibold underline decoration-1 underline-offset-2"
        >
          {match[0]}
        </span>,
      );
      at = start + match[0].length;
    }
    if (at < node.length) out.push(node.slice(at));
    return out;
  });
}

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * **What the search found, marked inside the message** (chat.md §8; owner, 2026-09-20: "підсвічуй
 * слово що б було зрозуміліше").
 *
 * Folded the way the search folds — lower case, accents and the Cyrillic breve and diaeresis
 * dropped — so typing "киів" marks "Київ", exactly as it finds it. Folding changes a string's
 * length, so each folded character remembers where it came from and the marks are cut out of the
 * ORIGINAL text; the reader sees what was written, with the hit standing out.
 */
function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function foldedWithMap(text: string): { folded: string; from: number[] } {
  let folded = "";
  const from: number[] = [];
  for (let i = 0; i < text.length; i++) {
    for (const ch of fold(text[i])) {
      folded += ch;
      from.push(i);
    }
  }
  from.push(text.length);
  return { folded, from };
}

/** Where each of the words is in the text, in the ORIGINAL string's own places, never overlapping. */
export function foundSpans(text: string, words: readonly string[]): [number, number][] {
  const needles = words.map(fold).filter(Boolean);
  if (needles.length === 0) return [];
  const { folded, from } = foldedWithMap(text);
  const spans: [number, number][] = [];
  for (const needle of needles) {
    for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, at + 1)) {
      spans.push([from[at], from[at + needle.length]]);
    }
  }
  // two words of the query can overlap in the text; one mark, not two nested
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  return merged;
}

function withFound(nodes: ReactNode[], words: readonly string[], key: string): ReactNode[] {
  if (words.length === 0) return nodes;
  return nodes.flatMap((node, i) => {
    if (typeof node !== "string") return [node];
    const merged = foundSpans(node, words);
    if (merged.length === 0) return [node];
    const out: ReactNode[] = [];
    let cursor = 0;
    for (const [start, end] of merged) {
      if (start > cursor) out.push(node.slice(cursor, start));
      out.push(
        <mark key={`${key}-${i}-${start}`} className="rounded-[3px] bg-found px-px text-ink">
          {node.slice(start, end)}
        </mark>,
      );
      cursor = end;
    }
    if (cursor < node.length) out.push(node.slice(cursor));
    return out;
  });
}

export function RichText({
  text,
  mentions = [],
  mine = false,
  found = [],
}: {
  text: string;
  mentions?: readonly string[];
  /** drawn on the reader's own bubble, which is the primary colour */
  mine?: boolean;
  /** the words the chat's search is looking for, marked wherever they appear (§8) */
  found?: readonly string[];
}) {
  return (
    <>
      {blocksOf(text).map((block, i) => {
        if (block.kind === "code") {
          return (
            <pre
              key={i}
              className="my-1 overflow-x-auto rounded-(--radius-field) bg-divider px-2 py-1.5 text-[12px] whitespace-pre-wrap"
            >
              <code>{block.lines.join("\n")}</code>
            </pre>
          );
        }
        const body = block.lines.map((line, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {withFound(
              withMentions(inline(line, `${i}-${j}`, 0, mine), mentions, `${i}-${j}`),
              found,
              `${i}-${j}`,
            )}
          </Fragment>
        ));
        return block.kind === "quote" ? (
          <blockquote key={i} className="my-1 border-l-2 border-border pl-2 text-ink-700">
            {body}
          </blockquote>
        ) : (
          <p key={i} className="whitespace-pre-wrap">
            {body}
          </p>
        );
      })}
    </>
  );
}

/**
 * What Ctrl+B and Ctrl+I do: wrap the selection, or open a pair for the next words. Returns the
 * whole field's new text and where the caret goes.
 */
export function wrapSelection(
  text: string,
  start: number,
  end: number,
  mark: string,
): { text: string; start: number; end: number } {
  const before = text.slice(0, start);
  const selected = text.slice(start, end);
  const after = text.slice(end);
  const already =
    before.endsWith(mark) && after.startsWith(mark)
      ? { text: before.slice(0, -mark.length) + selected + after.slice(mark.length) }
      : null;
  if (already) {
    return { text: already.text, start: start - mark.length, end: end - mark.length };
  }
  return {
    text: `${before}${mark}${selected}${mark}${after}`,
    start: start + mark.length,
    end: end + mark.length,
  };
}
