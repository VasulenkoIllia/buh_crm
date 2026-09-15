import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export interface ToastAction {
  label: string;
  run: () => unknown;
}

export interface ToastInput {
  text: string;
  /** one action at most — "Undo" after a delete (files.md §9) */
  action?: ToastAction;
}

interface Shown extends ToastInput {
  id: number;
}

const ToastContext = createContext<(toast: ToastInput) => void>(() => {});

/**
 * **One line at the bottom of the screen, one at a time.**
 *
 * Built for the Undo after a delete: the delete has happened, and the line says so and offers to
 * take it back for a few seconds. A second toast replaces the first rather than stacking, because
 * two Undo buttons on screen would leave nobody sure which one takes back what. An error still
 * belongs next to what failed, not here.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Shown | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const show = useCallback((next: ToastInput) => {
    window.clearTimeout(timer.current);
    const shown = { ...next, id: Date.now() };
    setToast(shown);
    timer.current = window.setTimeout(
      () => setToast((current) => (current?.id === shown.id ? null : current)),
      next.action ? 8000 : 4000,
    );
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 left-1/2 z-[60] flex max-w-[calc(100vw-48px)] -translate-x-1/2 items-center gap-3.5 rounded-[9px] bg-ink px-4 py-2.5 text-[13px] text-white shadow-(--shadow-modal)"
        >
          <span>{toast.text}</span>
          {toast.action && (
            <button
              type="button"
              className="rounded-[5px] px-2 py-1 font-semibold text-[#9fb2ff] hover:bg-white/10"
              onClick={() => {
                const action = toast.action;
                setToast(null);
                void action?.run();
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
