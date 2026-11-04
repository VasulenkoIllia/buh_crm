import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AddPaymentInput,
  CreateInvoiceInput,
  Invoice,
  InvoiceListQuery,
  LastRate,
  BulkTidyInput,
  BulkDeliveryInput,
  BulkResult,
  MarkPaidInput,
  SetDeliveryInput,
  UnbilledJob,
  UpdateInvoiceInput,
  UpdatePaymentInput,
} from "@shared/schema/payment";
import type { CreateInvoiceItemInput, InvoiceItem } from "@shared/schema/invoice-items";
import { api } from "@/shared/lib/api";
import {
  CLIENTS_KEY,
  FILES_KEY,
  INVOICE_ITEMS_KEY,
  INVOICES_KEY,
  TASKS_KEY,
} from "@/shared/lib/query-keys";
import { useToast } from "@/shared/ui/toast";

export interface InvoiceListResponse {
  items: Invoice[];
  total: number;
  page: number;
  pageSize: number;
  totals: { receivable: number; overdue: number };
  counts: Record<
    "all" | "unpaid" | "overdue" | "paid" | "unsent" | "cancelled" | "settled",
    number
  >;
}

export interface AuditEntry {
  id: string;
  action: "created" | "updated" | "deleted";
  byUserName: string;
  before: { amount: number; paidAt: string; reference: string | null } | null;
  after: { amount: number; paidAt: string; reference: string | null } | null;
  createdAt: string;
}

export function useInvoices(query: Partial<InvoiceListQuery>) {
  const params = new URLSearchParams();
  if (query.filter) params.set("filter", query.filter);
  if (query.clientId) params.set("clientId", query.clientId);
  if (query.companyId) params.set("companyId", query.companyId);
  if (query.search) params.set("search", query.search);
  if (query.page) params.set("page", String(query.page));
  if (query.pageSize) params.set("pageSize", String(query.pageSize));
  return useQuery({
    queryKey: [...INVOICES_KEY, "list", params.toString()],
    queryFn: () => api<InvoiceListResponse>(`/api/invoices?${params}`),
    placeholderData: (prev) => prev,
  });
}

export function useInvoice(id: string | undefined) {
  return useQuery({
    queryKey: [...INVOICES_KEY, "one", id],
    queryFn: () => api<Invoice>(`/api/invoices/${id}`),
    enabled: !!id,
  });
}

export function useInvoiceAudit(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: [...INVOICES_KEY, "audit", id],
    queryFn: () => api<AuditEntry[]>(`/api/invoices/${id}/audit`),
    enabled: !!id && enabled,
  });
}

function useInvalidateBilling() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: INVOICES_KEY });
    // a payment moves the client's debt, and an invoice can open (or bill) a job
    void queryClient.invalidateQueries({ queryKey: CLIENTS_KEY });
    void queryClient.invalidateQueries({ queryKey: TASKS_KEY });
  };
}

export function useCreateInvoice() {
  const invalidate = useInvalidateBilling();
  return useMutation({
    mutationFn: (input: CreateInvoiceInput) =>
      api<Invoice>("/api/invoices", { method: "POST", body: input }),
    // on a refusal too: "already billed" means the list of jobs on screen is out of date
    onSettled: invalidate,
  });
}

/** Under the invoices' key, so whatever bills or voids an invoice refreshes this list too. */
export function useUnbilledJobs(clientId: string | null) {
  return useQuery({
    queryKey: [...INVOICES_KEY, "unbilled-jobs", clientId],
    queryFn: () => api<UnbilledJob[]>(`/api/invoices/unbilled-jobs?clientId=${clientId}`),
    enabled: !!clientId,
  });
}

export function useAttachInvoice() {
  const invalidate = useInvalidateBilling();
  return useMutation({
    mutationFn: ({ invoiceId, taskId }: { invoiceId: string; taskId: string }) =>
      api<Invoice>(`/api/invoices/${invoiceId}/attach-job`, {
        method: "POST",
        body: { taskId },
      }),
    onSettled: invalidate,
  });
}

export function useAddPayment() {
  const invalidate = useInvalidateBilling();
  return useMutation({
    mutationFn: ({ invoiceId, input }: { invoiceId: string; input: AddPaymentInput }) =>
      api<Invoice>(`/api/invoices/${invoiceId}/payments`, { method: "POST", body: input }),
    onSuccess: invalidate,
  });
}

export function useUpdatePayment() {
  const invalidate = useInvalidateBilling();
  return useMutation({
    mutationFn: ({ paymentId, input }: { paymentId: string; input: UpdatePaymentInput }) =>
      api<Invoice>(`/api/invoices/payments/${paymentId}`, { method: "PATCH", body: input }),
    onSuccess: invalidate,
  });
}

export function useDeletePayment() {
  const invalidate = useInvalidateBilling();
  return useMutation({
    mutationFn: (paymentId: string) =>
      api<Invoice>(`/api/invoices/payments/${paymentId}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

/** Correct an issued invoice (admin): amount / description / due date. */
export function useUpdateInvoice() {
  const invalidate = useInvalidateBilling();
  return useMutation({
    mutationFn: ({ invoiceId, input }: { invoiceId: string; input: UpdateInvoiceInput }) =>
      api<Invoice>(`/api/invoices/${invoiceId}`, { method: "PATCH", body: input }),
    onSuccess: invalidate,
  });
}

/** Bulk marks from the list — no money moves, both reversible. */
export function useBulkDelivery() {
  const invalidate = useInvalidateBilling();
  return useMutation({
    mutationFn: (input: BulkDeliveryInput) =>
      api<BulkResult>("/api/invoices/bulk-delivery", { method: "POST", body: input }),
    onSuccess: invalidate,
  });
}

export function useBulkTidy() {
  const invalidate = useInvalidateBilling();
  return useMutation({
    mutationFn: (input: BulkTidyInput) =>
      api<BulkResult>("/api/invoices/bulk-tidy", { method: "POST", body: input }),
    onSuccess: invalidate,
  });
}

/** Mark the invoice as handed to the client (or undo the mark). */
export function useSetDelivery() {
  const invalidate = useInvalidateBilling();
  return useMutation({
    mutationFn: ({ invoiceId, input }: { invoiceId: string; input: SetDeliveryInput }) =>
      api<Invoice>(`/api/invoices/${invoiceId}/delivery`, { method: "POST", body: input }),
    onSuccess: invalidate,
  });
}

export function useCancelInvoice() {
  const invalidate = useInvalidateBilling();
  return useMutation({
    mutationFn: (invoiceId: string) =>
      api<Invoice>(`/api/invoices/${invoiceId}/cancel`, { method: "POST" }),
    onSuccess: invalidate,
  });
}

export function useMarkPaid() {
  const invalidate = useInvalidateBilling();
  return useMutation({
    mutationFn: (input: MarkPaidInput) =>
      api<{ settled: number; skipped: number }>("/api/invoices/mark-paid", {
        method: "POST",
        body: input,
      }),
    onSuccess: invalidate,
  });
}

/** The rate of this client's latest hourly position. `null` = nothing to ask yet. */
export function useLastRate(clientId: string | null) {
  return useQuery({
    queryKey: [...INVOICES_KEY, "last-rate", clientId],
    queryFn: () => api<LastRate>(`/api/invoices/last-rate?clientId=${clientId}`),
    enabled: clientId !== null,
  });
}

/**
 * A name a row's Position box did not find, added to the invoice items (payments.md §3, owner
 * 2026-11-04). Billing's own route, so whoever bills may, Settings closed or not. The answer is the
 * whole list, which replaces the cached one; the new item is the one of its name, unique case aside.
 */
export function useAddInvoiceItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateInvoiceItemInput) => {
      const list = await api<InvoiceItem[]>("/api/invoices/items", {
        method: "POST",
        body: input,
      });
      return { list, item: list.find((i) => i.name === input.name) };
    },
    onSuccess: ({ list }) => queryClient.setQueryData(INVOICE_ITEMS_KEY, list),
    // a refusal is mostly a colleague's item this cache has not seen yet: it comes in, and the
    // offer gives way to the item itself
    onError: () => queryClient.invalidateQueries({ queryKey: INVOICE_ITEMS_KEY }),
  });
}

/** Keeps a copy of the PDF in the client's files. The line says so even if the card has closed. */
export function useSaveInvoicePdf() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (invoiceId: string) =>
      api<{ fileId: string; name: string }>(`/api/invoices/${invoiceId}/save-pdf`, {
        method: "POST",
      }),
    onSuccess: (saved) => {
      toast({ text: `Saved to the client's files as ${saved.name}` });
      // the client's Files tab and its count are open behind this card
      void queryClient.invalidateQueries({ queryKey: FILES_KEY });
      void queryClient.invalidateQueries({ queryKey: CLIENTS_KEY });
    },
  });
}
