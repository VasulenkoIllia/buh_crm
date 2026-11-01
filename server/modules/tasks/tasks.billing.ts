import { hasLiveInvoice } from "@shared/schema/payment.js";
import type { UpdateTaskInput } from "@shared/schema/task.js";
import { record } from "../../core/activity.js";
import { failureReason, issueJobInvoice } from "../payments/index.js";
import * as repo from "./tasks.repository.js";

type JobInvoice = Parameters<typeof issueJobInvoice>[0];

/**
 * What completing this job bills, or null when it bills nothing.
 *
 * Read BEFORE the task is written. A lookup that failed after the write would answer an error for a
 * job already done, with nothing in the log; failing before it, the job simply stays as it was.
 */
export async function invoiceDueOnCompletion(
  task: repo.TaskRecord,
  input: UpdateTaskInput,
): Promise<JobInvoice | null> {
  if (input.done !== true || task.kind !== "once" || hasLiveInvoice(task) || !task.clientId) {
    return null;
  }
  const amount = input.amount !== undefined ? input.amount : task.amount;
  if (amount == null) return null;
  const sub = task.subscriptionId
    ? await repo.findClientSubscription(task.clientId, task.subscriptionId)
    : null;
  if ((sub?.invoiceTrigger ?? sub?.service.invoiceTrigger) !== "on_complete") return null;
  return {
    taskId: task.id,
    clientId: task.clientId,
    companyId: task.companyId,
    serviceId: task.serviceId,
    amount,
    dueDays: sub?.dueDays ?? sub?.service.dueDays ?? null,
  };
}

/**
 * Issue a job's invoice without letting a failure undo the task already written.
 *
 * The task is saved by now, so an error answer would be untrue: the person would see a failure, a
 * second try from the form would make a second task, and the log would say the completion broke.
 * Instead the failure is the log's own row and the caller reports it in a successful answer.
 */
export async function billJob(title: string, input: JobInvoice) {
  try {
    await issueJobInvoice(input);
    return true;
  } catch (err) {
    console.error("tasks: could not issue the invoice of job", input.taskId, err);
    record("task.invoice_failed", {
      outcome: "failed",
      subjectId: input.taskId,
      subjectLabel: title,
      clientId: input.clientId,
      changes: { amount: input.amount, error: failureReason(err) },
    });
    return false;
  }
}
