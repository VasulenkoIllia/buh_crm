import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CampaignDetail, CampaignInput, CampaignList } from "@shared/schema/campaigns";
import type {
  ClientMailoutDetail,
  ClientMailState,
  CreateTemplateInput,
  EmailTemplate,
  LetterPreview,
  MailoutDetail,
  MailoutList,
  MailoutPreview,
  MailSenderState,
  PreviewLetterInput,
  SenderTestResult,
  SendMailoutInput,
  SenderAccountInput,
  UpdateFirmMailInput,
  UpdateTemplateInput,
} from "@shared/schema/mailouts";
import { api } from "@/shared/lib/api";
import { MAILOUTS_KEY } from "@/shared/lib/query-keys";

const TEMPLATES_KEY = [...MAILOUTS_KEY, "templates"] as const;
const SENDER_KEY = [...MAILOUTS_KEY, "sender"] as const;

// ── templates ────────────────────────────────────────────────────────────────

export function useTemplates() {
  return useQuery({
    queryKey: TEMPLATES_KEY,
    queryFn: () => api<EmailTemplate[]>("/api/mailouts/templates"),
    staleTime: 30_000,
  });
}

/**
 * The whole Mailouts tree, not just the templates list.
 *
 * A template's NAME is shown by five other screens — the campaigns list and card, the Sent log, a
 * mailout's detail and a client's card — because each of them names the letter it came from.
 * Invalidating only `TEMPLATES_KEY` left a renamed template reading as its old name everywhere
 * else until something happened to refetch.
 */
function useInvalidateTemplates() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: MAILOUTS_KEY });
}

export function useCreateTemplate() {
  const invalidate = useInvalidateTemplates();
  return useMutation({
    mutationFn: (input: CreateTemplateInput) =>
      api<EmailTemplate>("/api/mailouts/templates", { method: "POST", body: input }),
    onSuccess: invalidate,
  });
}

export function useUpdateTemplate() {
  const invalidate = useInvalidateTemplates();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateTemplateInput }) =>
      api<EmailTemplate>(`/api/mailouts/templates/${id}`, { method: "PATCH", body: input }),
    onSuccess: invalidate,
  });
}

export function useDeleteTemplate() {
  const invalidate = useInvalidateTemplates();
  return useMutation({
    mutationFn: (id: string) =>
      api<void>(`/api/mailouts/templates/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

// ── preview and send ─────────────────────────────────────────────────────────

/**
 * A mutation rather than a query on purpose: the composer decides WHEN to look (on demand, not on
 * every keystroke), and a preview of a half-typed letter is noise.
 */
export function usePreviewMailout() {
  return useMutation({
    mutationFn: (input: SendMailoutInput) =>
      api<MailoutPreview>("/api/mailouts/preview", { method: "POST", body: input }),
  });
}

/** "What does this letter look like" — sample values, no recipients. The template editor's. */
export function usePreviewLetter() {
  return useMutation({
    mutationFn: (input: PreviewLetterInput) =>
      api<LetterPreview>("/api/mailouts/preview/letter", { method: "POST", body: input }),
  });
}

export function useSendMailout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SendMailoutInput) =>
      api<MailoutDetail>("/api/mailouts/send", { method: "POST", body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: MAILOUTS_KEY }),
  });
}

// ── the log ──────────────────────────────────────────────────────────────────

export function useMailouts(params: { page: number; pageSize: number }) {
  const query = new URLSearchParams({
    page: String(params.page),
    pageSize: String(params.pageSize),
  });
  return useQuery({
    queryKey: [...MAILOUTS_KEY, "list", params],
    queryFn: () => api<MailoutList>(`/api/mailouts?${query}`),
  });
}

/**
 * Delivery runs after the response, so a just-sent mailout arrives with rows still `queued`.
 * Poll while any remain — and stop the moment none do, rather than refetching forever.
 */
export function useMailoutDetail(id: string | null) {
  return useQuery({
    queryKey: [...MAILOUTS_KEY, "detail", id],
    queryFn: () => api<MailoutDetail>(`/api/mailouts/${id}`),
    enabled: !!id,
    refetchInterval: (query) => (query.state.data?.counts.queued ? 1500 : false),
  });
}

// ── the client card ──────────────────────────────────────────────────────────

/**
 * Never served from cache, and refetched when the tab regains focus.
 *
 * The app's default `staleTime` of 30s suits data that only this app changes. This does not: a
 * client unsubscribes by clicking a link in their own email, so the value can go stale while
 * nobody in the CRM has touched anything. Showing a cached "Subscribed" after they opted out is
 * how a firm mails someone who asked them not to.
 */
export function useClientMailState(clientId: string, page: number, pageSize: number) {
  const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  return useQuery({
    queryKey: [...MAILOUTS_KEY, "client", clientId, page, pageSize],
    queryFn: () => api<ClientMailState>(`/api/mailouts/clients/${clientId}?${query}`),
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchOnMount: "always",
    /** Page 2 keeps page 1 on screen while it loads, so the tab does not blink back to "Loading…". */
    placeholderData: (prev) => prev,
  });
}

/**
 * One letter as this client received it — scoped, so a client's card can never show another's row.
 *
 * Keyed on the RECIPIENT row, not the mailout: one mailout may reach this client at their own
 * address and at each of their companies, and those are different letters.
 */
export function useClientLetter(letterId: string | null, clientId: string) {
  return useQuery({
    queryKey: [...MAILOUTS_KEY, "client", clientId, "letter", letterId],
    queryFn: () =>
      api<ClientMailoutDetail>(`/api/mailouts/clients/${clientId}/letters/${letterId}`),
    enabled: !!letterId,
  });
}

export function useSetSubscription(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (subscribed: boolean) =>
      api<ClientMailState>(`/api/mailouts/clients/${clientId}/subscription`, {
        method: "PATCH",
        body: { subscribed },
      }),
    /**
     * Invalidate rather than write the response in. The endpoint answers with the FIRST page, and
     * the query is now keyed by page — writing it back would either miss the live key entirely or
     * shove page 1 under somebody sitting on page 3. Refetching costs one round trip on a rare
     * action and always lands on the page the reader is actually looking at.
     */
    onSuccess: () => qc.invalidateQueries({ queryKey: [...MAILOUTS_KEY, "client", clientId] }),
  });
}

// ── sender mailboxes ─────────────────────────────────────────────────────────

export function useMailSenders() {
  return useQuery({
    queryKey: SENDER_KEY,
    queryFn: () => api<MailSenderState>("/api/mailouts/settings/senders"),
    staleTime: 60_000,
  });
}

/**
 * Every mutation returns the WHOLE state, and writes it straight into the cache.
 *
 * Deliberate: making one mailbox the default clears the flag on another, and a per-item update
 * would leave the list briefly showing two defaults. One authoritative answer per change.
 */
function useSenderMutation<T>(fn: (input: T) => Promise<MailSenderState>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => qc.setQueryData(SENDER_KEY, data),
  });
}

export function useCreateSender() {
  return useSenderMutation((input: SenderAccountInput) =>
    api<MailSenderState>("/api/mailouts/settings/senders", { method: "POST", body: input }),
  );
}

export function useUpdateSender() {
  return useSenderMutation(({ id, input }: { id: string; input: SenderAccountInput }) =>
    api<MailSenderState>(`/api/mailouts/settings/senders/${id}`, {
      method: "PATCH",
      body: input,
    }),
  );
}

export function useMakeSenderDefault() {
  return useSenderMutation((id: string) =>
    api<MailSenderState>(`/api/mailouts/settings/senders/${id}/default`, { method: "POST" }),
  );
}

export function useMakeInvoiceSender() {
  return useSenderMutation((id: string) =>
    api<MailSenderState>(`/api/mailouts/settings/senders/${id}/invoice-sender`, {
      method: "POST",
    }),
  );
}

export function useDeleteSender() {
  return useSenderMutation((id: string) =>
    api<MailSenderState>(`/api/mailouts/settings/senders/${id}`, { method: "DELETE" }),
  );
}

/** Multipart, so it bypasses the JSON `api()` helper — same cookie, same origin. */
export function useSetMailLogo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/mailouts/settings/mail-logo", { method: "PUT", body });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message ?? "Could not upload the letterhead");
      return json as MailSenderState;
    },
    onSuccess: (data) => qc.setQueryData(SENDER_KEY, data),
  });
}

export function useRemoveMailLogo() {
  return useSenderMutation(() =>
    api<MailSenderState>("/api/mailouts/settings/mail-logo", { method: "DELETE" }),
  );
}

export function useUpdateFirmMail() {
  return useSenderMutation((input: UpdateFirmMailInput) =>
    api<MailSenderState>("/api/mailouts/settings/firm-mail", { method: "PATCH", body: input }),
  );
}

/**
 * Make a mailbox prove itself. Not cached and not retried: the answer is about this instant, and a
 * retry would open a second outbound connection the admin did not ask for.
 */
export function useTestSender() {
  return useMutation({
    retry: false,
    mutationFn: ({ id, sendTestLetter }: { id: string; sendTestLetter: boolean }) =>
      api<SenderTestResult>(`/api/mailouts/settings/senders/${id}/test`, {
        method: "POST",
        body: { sendTestLetter },
      }),
  });
}

// ── campaigns ────────────────────────────────────────────────────────────────

const CAMPAIGNS_KEY = [...MAILOUTS_KEY, "campaigns"] as const;

export function useCampaigns() {
  return useQuery({
    queryKey: CAMPAIGNS_KEY,
    queryFn: () => api<CampaignList>("/api/mailouts/campaigns"),
    staleTime: 30_000,
  });
}

export function useCampaign(id: string | null) {
  return useQuery({
    queryKey: [...CAMPAIGNS_KEY, id],
    queryFn: () => api<CampaignDetail>(`/api/mailouts/campaigns/${id}`),
    enabled: !!id,
  });
}

/**
 * Every campaign mutation invalidates the whole Mailouts tree, not just the campaign list.
 *
 * Firing writes into the Sent log and can move a client's subscription state, and a screen showing
 * a campaign as "due today" beside a log that already lists its run is worse than a refetch.
 */
function useCampaignMutation<T, R>(fn: (input: T) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: MAILOUTS_KEY }),
  });
}

export function useCreateCampaign() {
  return useCampaignMutation((input: CampaignInput) =>
    api<CampaignDetail>("/api/mailouts/campaigns", { method: "POST", body: input }),
  );
}

export function useUpdateCampaign() {
  return useCampaignMutation(({ id, input }: { id: string; input: CampaignInput }) =>
    api<CampaignDetail>(`/api/mailouts/campaigns/${id}`, { method: "PUT", body: input }),
  );
}

export function useSetCampaignActive() {
  return useCampaignMutation(({ id, active }: { id: string; active: boolean }) =>
    api<CampaignDetail>(`/api/mailouts/campaigns/${id}/active`, {
      method: "POST",
      body: { active },
    }),
  );
}

export function useDeleteCampaign() {
  return useCampaignMutation((id: string) =>
    api<void>(`/api/mailouts/campaigns/${id}`, { method: "DELETE" }),
  );
}
