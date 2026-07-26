import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AddPaymentInput,
  CreateInvoiceInput,
  Invoice,
  InvoiceListQuery,
  BulkArchiveInput,
  BulkDeliveryInput,
  BulkResult,
  MarkPaidInput,
  SetDeliveryInput,
  UpdateInvoiceInput,
  UpdatePaymentInput,
} from "@shared/schema/payment";
import { api } from "@/shared/lib/api";
import { CLIENTS_KEY, INVOICES_KEY, TASKS_KEY } from "@/shared/lib/query-keys";

export interface InvoiceListResponse {
  items: Invoice[];
  total: number;
  page: number;
  pageSize: number;
  totals: { receivable: number; overdue: number };
  counts: Record<"all" | "unpaid" | "overdue" | "paid" | "unsent" | "cancelled" | "archived", number>;
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
    onSuccess: invalidate,
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

export function useBulkArchive() {
  const invalidate = useInvalidateBilling();
  return useMutation({
    mutationFn: (input: BulkArchiveInput) =>
      api<BulkResult>("/api/invoices/bulk-archive", { method: "POST", body: input }),
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
