interface ComingSoonProps {
  module: string;
  stage: string;
}

export function ComingSoon({ module, stage }: ComingSoonProps) {
  return (
    <div className="flex h-full min-h-64 flex-col items-center justify-center rounded-(--radius-panel) border border-border bg-surface p-10 shadow-(--shadow-card)">
      <h1 className="text-[20px] font-semibold">{module}</h1>
      <p className="mt-2 text-[13px] text-muted">
        Coming in stage {stage} — see the dev plan.
      </p>
    </div>
  );
}
