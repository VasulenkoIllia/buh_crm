import { useState } from "react";
import type { Invoice, UnbilledJob } from "@shared/schema/payment";
import { cn } from "@/shared/lib/cn";
import { fmtMoney } from "@/shared/lib/money";
import { Button } from "@/shared/ui/button";
import { FormField } from "@/shared/ui/field";
import { SearchSelect } from "@/shared/ui/search-select";
import { useAttachInvoice, useUnbilledJobs } from "./payments.api";

/** Service, company and price, so two jobs with the same title can be told apart. */
const jobOption = (job: UnbilledJob) => ({
  value: job.id,
  label: job.title,
  hint: [job.serviceName, job.companyName, job.amount != null ? fmtMoney(job.amount) : null]
    .filter(Boolean)
    .join(" · "),
});

/** Which job an invoice goes on. Nothing is asked until the form is on that choice. */
export function useJobChoice(
  clientId: string | null,
  choosing: boolean,
  presetJobId: string | undefined,
) {
  const [jobId, setJobId] = useState(presetJobId ?? "");
  const { data, isLoading, isError } = useUnbilledJobs(choosing ? clientId : null);
  const jobs = data ?? [];
  const job = choosing ? (jobs.find((j) => j.id === jobId) ?? null) : null;
  return { clientId, jobs, isLoading, isError, job, jobId, setJobId };
}

type JobChoice = ReturnType<typeof useJobChoice>;

/**
 * The one line under the picker. An invoice replaces the job's price and nothing takes the link
 * back, so a different total is said before it is pressed, and a list that failed to load must not
 * read as a client with no jobs.
 */
function jobNote({ clientId, jobs, isLoading, isError, job, jobId }: JobChoice, total: number) {
  if (isError) return "Could not load this client's jobs. Close this and try again.";
  if (isLoading) return "Loading jobs…";
  if (clientId && jobs.length === 0) return "This client has no unbilled jobs.";
  if (jobId && !job)
    return "That job can't be billed: it has an invoice, or it was called off.";
  if (job && total > 0 && job.amount !== total) {
    return job.amount != null
      ? `The job's price changes from ${fmtMoney(job.amount)} to ${fmtMoney(total)}.`
      : `The job's price becomes ${fmtMoney(total)}.`;
  }
  return "The invoice goes on this job, and the job's price follows it.";
}

function JobPicker({ choice }: { choice: JobChoice }) {
  const { clientId, jobs, jobId, setJobId } = choice;
  return (
    <SearchSelect
      ariaLabel="Job"
      value={jobId}
      onChange={setJobId}
      disabled={!clientId}
      placeholder={clientId ? "Search this client's unbilled jobs…" : "Pick a client first"}
      emptyLabel="No job picked"
      options={jobs.map(jobOption)}
    />
  );
}

function JobNote({ choice, total }: { choice: JobChoice; total: number }) {
  return (
    <p className={cn("text-[12px] text-faint", choice.isError && "text-danger-text")}>
      {jobNote(choice, total)}
    </p>
  );
}

/** The New invoice form's "For a job". */
export function JobChoiceField({ choice, total }: { choice: JobChoice; total: number }) {
  return (
    <div className="flex flex-col gap-2 rounded-(--radius-panel) bg-[#f7f8fa] p-3">
      <FormField label="Job">
        <JobPicker choice={choice} />
      </FormField>
      <JobNote choice={choice} total={total} />
    </div>
  );
}

/** Putting an invoice already issued on a job (admin). */
export function AttachJob({ invoice }: { invoice: Invoice }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choice = useJobChoice(invoice.clientId, open, undefined);
  const attach = useAttachInvoice();

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Attach to a job
      </Button>
    );
  }

  async function submit() {
    setError(null);
    try {
      await attach.mutateAsync({ invoiceId: invoice.id, taskId: choice.jobId });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function cancel() {
    setOpen(false);
    setError(null);
    choice.setJobId("");
  }

  return (
    <div className="flex flex-col gap-2">
      <JobPicker choice={choice} />
      <JobNote choice={choice} total={invoice.amount} />
      {error && <p className="text-[12px] text-danger-text">{error}</p>}
      <div className="flex gap-2">
        {/* isSuccess too: the button stays on screen until the refreshed invoice replaces it */}
        <Button
          size="sm"
          disabled={!choice.job || attach.isPending || attach.isSuccess}
          onClick={() => void submit()}
        >
          Attach
        </Button>
        <Button variant="secondary" size="sm" onClick={cancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
