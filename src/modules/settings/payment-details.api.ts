import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreatePaymentDetailsInput,
  PaymentDetails,
  PaymentDetailsOption,
  UpdatePaymentDetailsInput,
} from "@shared/schema/payment-details";
import { api } from "@/shared/lib/api";
import { CLIENTS_KEY, INVOICES_KEY, PAYMENT_DETAILS_KEY } from "@/shared/lib/query-keys";

const OPTIONS_KEY = [...PAYMENT_DETAILS_KEY, "options"] as const;
const BASE = "/api/settings/payment-details";

/** The sets with their text: Settings → Invoices only (the `settings` gate). */
export function usePaymentDetails() {
  return useQuery({
    queryKey: PAYMENT_DETAILS_KEY,
    queryFn: () => api<PaymentDetails[]>(BASE),
  });
}

/** Live sets by name, for screens that are not Settings: the client card, New invoice. */
export function usePaymentDetailsOptions() {
  return useQuery({
    queryKey: OPTIONS_KEY,
    queryFn: () => api<PaymentDetailsOption[]>(`${BASE}/options`),
    staleTime: 60_000,
  });
}

/**
 * Every write answers with the whole list. The names elsewhere follow: a renamed set is renamed on
 * the client card and on its invoices too.
 */
function usePaymentDetailsWrite<T>(request: (input: T) => Promise<PaymentDetails[]>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (list) => {
      qc.setQueryData(PAYMENT_DETAILS_KEY, list);
      void qc.invalidateQueries({ queryKey: OPTIONS_KEY });
      void qc.invalidateQueries({ queryKey: CLIENTS_KEY });
      void qc.invalidateQueries({ queryKey: INVOICES_KEY });
    },
  });
}

export const useCreatePaymentDetails = () =>
  usePaymentDetailsWrite((input: CreatePaymentDetailsInput) =>
    api<PaymentDetails[]>(BASE, { method: "POST", body: input }),
  );

export const useUpdatePaymentDetails = () =>
  usePaymentDetailsWrite(({ id, input }: { id: string; input: UpdatePaymentDetailsInput }) =>
    api<PaymentDetails[]>(`${BASE}/${id}`, { method: "PATCH", body: input }),
  );

export const useMakePaymentDetailsDefault = () =>
  usePaymentDetailsWrite((id: string) =>
    api<PaymentDetails[]>(`${BASE}/${id}/default`, { method: "POST" }),
  );

export const useArchivePaymentDetails = () =>
  usePaymentDetailsWrite((id: string) =>
    api<PaymentDetails[]>(`${BASE}/${id}/archive`, { method: "POST" }),
  );
