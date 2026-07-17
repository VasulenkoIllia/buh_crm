import type { ReactNode } from "react";

/** Centered card shell for all auth screens (design: radius 14, app background). */
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-app-bg p-4">
      <div className="w-full max-w-sm rounded-(--radius-auth) border border-border bg-surface p-8 shadow-(--shadow-card)">
        <div className="mb-1 text-center text-[13px] font-semibold tracking-wide text-primary-link">
          buh_crm
        </div>
        <h1 className="mb-6 text-center text-[20px] font-semibold">{title}</h1>
        {children}
      </div>
    </div>
  );
}
