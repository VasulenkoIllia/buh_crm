import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateInvoiceItemInput,
  InvoiceItem,
  UpdateInvoiceItemInput,
} from "@shared/schema/invoice-items";
import { api } from "@/shared/lib/api";
import { INVOICE_ITEMS_KEY } from "@/shared/lib/query-keys";

const BASE = "/api/settings/invoice-items";

/** Every item, inactive ones too, by name (`shared()`): Settings and the lines editor both read it. */
export function useInvoiceItems() {
  return useQuery({
    queryKey: INVOICE_ITEMS_KEY,
    queryFn: () => api<InvoiceItem[]>(BASE),
    staleTime: 60_000,
  });
}

/** Every write answers with the whole list, which replaces the cached one. */
function useInvoiceItemsWrite<T>(request: (input: T) => Promise<InvoiceItem[]>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (list) => qc.setQueryData(INVOICE_ITEMS_KEY, list),
  });
}

export const useCreateInvoiceItem = () =>
  useInvoiceItemsWrite((input: CreateInvoiceItemInput) =>
    api<InvoiceItem[]>(BASE, { method: "POST", body: input }),
  );

export const useUpdateInvoiceItem = () =>
  useInvoiceItemsWrite(({ id, input }: { id: string; input: UpdateInvoiceItemInput }) =>
    api<InvoiceItem[]>(`${BASE}/${id}`, { method: "PATCH", body: input }),
  );

export const useDeleteInvoiceItem = () =>
  useInvoiceItemsWrite((id: string) =>
    api<InvoiceItem[]>(`${BASE}/${id}`, { method: "DELETE" }),
  );
