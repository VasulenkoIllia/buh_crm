import type { HTMLAttributes, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { errorText } from "./file-bits";
import { useLibrary } from "./library-context";
import type { View } from "./places";

/** The cells every pane draws with, so one pane's columns sit where the next one's do. */
export const TH =
  "whitespace-nowrap border-b border-divider px-2.5 py-[9px] text-left text-[11.5px] font-semibold uppercase tracking-[0.04em] text-muted-400";
export const TD =
  "whitespace-nowrap border-b border-divider px-2.5 py-2 align-middle text-ink-700";
/** the last row of a table draws no line under itself */
export const ROW = "[&:last-child>td]:border-b-0";
export const CHECK_CELL = "w-[34px] pl-[18px] pr-0";
export const MENU_CELL = "w-11 pr-3 text-right";

/** The right-hand panel: where you are, what the place is, what is chosen, then the list. */
export function PaneFrame({
  label,
  crumbs,
  tools,
  note,
  bar,
  children,
  className,
  ...rest
}: Omit<HTMLAttributes<HTMLElement>, "children"> & {
  label: string;
  crumbs: ReactNode;
  tools?: ReactNode;
  note?: ReactNode;
  bar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className={cn(
        "relative flex min-h-[440px] min-w-0 flex-col rounded-(--radius-panel) border border-border bg-surface shadow-(--shadow-card)",
        className,
      )}
      {...rest}
    >
      <div className="flex flex-col gap-2.5 px-[18px] pb-2.5 pt-3.5">
        <div className="flex min-h-7 items-center justify-between gap-3">
          {crumbs}
          {tools}
        </div>
        {note}
      </div>
      {bar && (
        <div className="flex min-h-11 flex-wrap items-center gap-2 border-y border-divider px-[18px] py-1.5">
          {bar}
        </div>
      )}
      {children}
    </section>
  );
}

export interface Crumb {
  key: string;
  label: ReactNode;
  /** where it leads; the last one, where you are, leads nowhere */
  view?: View;
}

export function CrumbTrail({ parts }: { parts: Crumb[] }) {
  const lib = useLibrary();
  return (
    <nav
      aria-label="Where you are"
      className="flex min-w-0 flex-wrap items-center gap-1 text-[13px] text-muted"
    >
      {parts.map((part, i) => {
        const view = part.view;
        return (
          <span key={part.key} className="flex items-center gap-1">
            {i > 0 && <ChevronRight size={12} className="text-faint" aria-hidden />}
            {view ? (
              <button
                type="button"
                onClick={() => lib.go(view)}
                className="flex items-center rounded px-1 py-0.5 text-muted hover:bg-[#eef1fd] hover:text-primary-link"
              >
                {part.label}
              </button>
            ) : (
              <span
                aria-current="location"
                className="flex items-center px-1 py-0.5 font-semibold text-ink"
              >
                {part.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}

const NOTE_TONE = {
  plain: "bg-divider text-ink-700",
  shared: "bg-[#eef1fd] text-[#243a9e]",
  from: "bg-[#e5f5f2] text-[#0b5e53]",
} as const;

/** What a place is, in one line, above its list. */
export function Note({
  icon,
  tone = "plain",
  children,
}: {
  icon: ReactNode;
  tone?: keyof typeof NOTE_TONE;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-(--radius-card) px-3 py-2 text-[12.5px]",
        NOTE_TONE[tone],
      )}
    >
      <span className="mt-px flex-none">{icon}</span>
      <span>{children}</span>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="grid justify-items-center gap-2 px-6 py-14 text-center text-[13px] text-muted">
      <span className="grid h-11 w-11 place-items-center rounded-xl bg-divider text-faint">
        {icon}
      </span>
      <b className="text-[14px] font-semibold text-ink-700">{title}</b>
      {children}
    </div>
  );
}

export function Loading() {
  return <p className="px-[18px] py-6 text-[13px] text-muted">Loading…</p>;
}

export function PaneError({ error }: { error: unknown }) {
  return <p className="px-[18px] py-6 text-[13px] text-danger-text">{errorText(error)}</p>;
}

/** The head of a group: a gesture in the Trash, a task in Attachments. */
export function GroupHead({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 border-b border-divider bg-[#fafbfc] px-[18px] py-2.5 text-[12.5px] text-ink-700">
      {children}
    </div>
  );
}
