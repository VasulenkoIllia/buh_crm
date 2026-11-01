import { hasLiveInvoice, type UnbilledJob } from "@shared/schema/payment.js";
import { record } from "../../core/activity.js";
import { ConflictError, NotFoundError, ValidationError } from "../../core/errors.js";
import { issueInvoiceIn, recordIssued, type IssueInvoiceInput } from "./invoicing.js";
import * as repo from "./payments.repository.js";

/**
 * A one-time job billed by hand (payments.md §5). Both ways in, issuing on the job and attaching an
 * invoice already issued, end on the same link `issueJobInvoice` writes, so `hasLiveInvoice` is the
 * one answer to "is this job billed", and Reopen and Done cannot bill it again.
 */

/**
 * Same order as `liveTaskOr404`, then what only billing asks. Asked twice on purpose: before the
 * transaction for a plain answer and the job's service and company, and under the row lock because
 * only that answer is safe to act on.
 */
function assertTakesInvoice(
  job: repo.JobForBilling | null,
  clientId: string,
): asserts job is repo.JobForBilling {
  if (!job || job.archivedAt || job.client?.archivedAt)
    throw new NotFoundError("Job not found");
  if (job.kind !== "once" || job.clientId !== clientId) {
    throw new ValidationError("That is not one of this client's one-time jobs");
  }
  if (job.cancelledAt) throw new ConflictError("This job was called off. Restore it first");
  if (hasLiveInvoice(job)) {
    throw new ConflictError(`This job is already billed by ${job.invoice?.number}`);
  }
}

export async function jobToBill(taskId: string, clientId: string) {
  const job = await repo.findJobForBilling(taskId);
  assertTakesInvoice(job, clientId);
  return job;
}

/**
 * Recorded on the JOB because that is where somebody asks why it stopped reading unbilled, and the
 * invoice's number is in the entry. The price is there only when it moved.
 */
function recordAttached(
  job: repo.JobForBilling,
  invoice: { number: string; amount: number; clientId: string },
) {
  record("task.invoice_attached", {
    subjectId: job.id,
    subjectLabel: job.title,
    clientId: invoice.clientId,
    changes: {
      invoice: invoice.number,
      ...(job.amount !== invoice.amount
        ? { amount: { from: job.amount, to: invoice.amount } }
        : {}),
    },
  });
}

/** Issue a hand-made invoice for a job, under the row lock `issueJobInvoice` takes. */
export async function issueInvoiceOnJob(taskId: string, input: IssueInvoiceInput) {
  const { job, invoice } = await repo.inTransaction(async (tx) => {
    const job = await repo.lockTaskForInvoicing(tx, taskId);
    assertTakesInvoice(job, input.clientId);
    const invoice = await issueInvoiceIn(tx, input);
    if (input.lines?.length) await repo.replaceLines(tx, invoice.id, input.lines);
    await repo.linkJobToInvoice(tx, taskId, invoice.id, invoice.amount);
    return { job, invoice };
  });
  recordIssued(invoice);
  recordAttached(job, invoice);
  return invoice;
}

/**
 * Attach an invoice already issued to a job with no live invoice (admin).
 *
 * The invoice's lock comes first and nothing locks them the other way round. A period's invoice is
 * refused because it bills the period: a job on it would read as billed and the sum would be the
 * whole period's.
 */
export async function attachInvoice(invoiceId: string, taskId: string) {
  const issued = await repo.findInvoice(invoiceId);
  if (!issued) throw new NotFoundError("Invoice not found");
  await jobToBill(taskId, issued.clientId);

  const { job, invoice } = await repo.inTransaction(async (tx) => {
    const invoice = await repo.lockInvoiceForAttaching(tx, invoiceId);
    if (invoice.cancelledAt) {
      throw new ValidationError("A cancelled invoice can't be attached to a job");
    }
    if (invoice.periodKey) {
      throw new ValidationError("This invoice bills a period, not a job");
    }
    if (invoice.tasks[0]) {
      throw new ConflictError(`This invoice already bills ${invoice.tasks[0].title}`);
    }
    const job = await repo.lockTaskForInvoicing(tx, taskId);
    assertTakesInvoice(job, invoice.clientId);
    await repo.linkJobToInvoice(tx, taskId, invoiceId, invoice.amount);
    return { job, invoice };
  });
  recordAttached(job, invoice);
}

export async function listUnbilledJobs(clientId: string): Promise<UnbilledJob[]> {
  const jobs = await repo.listUnbilledJobs(clientId);
  return jobs.map(({ service, company, ...job }) => ({
    ...job,
    serviceName: service?.name ?? null,
    companyName: company?.name ?? null,
  }));
}
