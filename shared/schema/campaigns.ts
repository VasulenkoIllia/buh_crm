import { z } from "zod";
import { uuid } from "./common.js";
import { campaignRhythm, campaignStatus, mailoutKind } from "./enums.js";
import { mailoutTarget } from "./mailouts.js";

// `clientCampaignSchema` lives in `mailouts.js`, beside the client-card state that carries it.
// The dependency between these two modules has to run one way — campaigns → mailouts — or the
// zod values reference each other at module-init time and one of them is `undefined`.
export { clientCampaignSchema, type ClientCampaign } from "./mailouts.js";

/**
 * Campaigns (S10.1) — a planned mailout: a template, a list, and a date it goes out on.
 *
 * A campaign never sends. When its date comes round it **creates an ordinary Mailout**, which is
 * what actually goes out and what the Sent log records. So "did this letter leave the building"
 * has exactly one answer whether a person pressed Send or a date arrived, and every screen that
 * already reads the log keeps working untouched.
 *
 * The list is the firm's, not a rule: they name who, and can edit that list right up to the date.
 * A rule ("everyone with service X") would mean nobody knows who is about to be written to until
 * after it has happened.
 */

export const campaignInput = z
  .object({
    name: z.string().trim().min(1, "Required").max(80),
    templateId: uuid,
    senderAccountId: uuid.nullable().optional(),
    /**
     * Commercial by default, and choosing otherwise is deliberate.
     *
     * A transactional campaign reaches clients who unsubscribed and carries no unsubscribe link —
     * lawful for a bill or a document request, unlawful for news. The editor says so before
     * letting it be chosen; this is the field it sets.
     */
    kind: mailoutKind.default("commercial"),
    rhythm: campaignRhythm.default("once"),
    /**
     * The first date it fires; for a rhythm, also the anchor day of the month.
     *
     * For `dates` it is DERIVED — the service sets it to the earliest day on the list and ignores
     * whatever was sent, because the list is the only source of truth there and two fields that
     * can disagree eventually will.
     */
    startsOn: z.iso.date(),
    /** the hand-picked days, for `rhythm: "dates"` and meaningless otherwise */
    dates: z.array(z.iso.date()).max(60).optional(),
    /** firm-local time of day — the sweep runs daily, this only decides which side of it */
    sendAt: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM")
      .default("09:00"),
    /** a rhythm's last allowed date; null = until somebody stops it */
    endsOn: z.iso.date().nullable().optional(),
    recipients: z.array(mailoutTarget).min(1, "Pick at least one recipient").max(500),
  })
  .refine((v) => v.rhythm !== "dates" || (v.dates?.length ?? 0) > 0, {
    path: ["dates"],
    message: "Pick at least one date",
  })
  .refine((v) => v.rhythm !== "dates" || new Set(v.dates).size === (v.dates?.length ?? 0), {
    path: ["dates"],
    message: "The same date twice",
  })
  // "stop after" is a rule's limit; a list already says when it ends by ending
  .refine((v) => (v.rhythm !== "once" && v.rhythm !== "dates") || !v.endsOn, {
    path: ["endsOn"],
    message: "Only a repeating campaign has an end date — a list ends when it runs out",
  })
  .refine((v) => !v.endsOn || v.endsOn >= v.startsOn, {
    path: ["endsOn"],
    message: "The end date is before the start",
  });
export type CampaignInput = z.infer<typeof campaignInput>;

/** Everything is editable while a campaign is `scheduled`; the service refuses the rest. */
export const updateCampaignInput = campaignInput;
export type UpdateCampaignInput = CampaignInput;

/** One addressee on a campaign's list, resolved for display. */
export const campaignRecipientSchema = z.object({
  clientId: uuid,
  companyId: uuid.nullable(),
  clientName: z.string(),
  /** null = the client's own address */
  companyName: z.string().nullable(),
  email: z.string().nullable(),
  /**
   * Why this addressee would be skipped **right now** — no address, or opted out of commercial
   * mail. Advisory and live: the send path decides again on the day, because a client can
   * unsubscribe between planning and sending, which is exactly the case this campaign must honour.
   */
  blockedReason: z.string().nullable(),
});
export type CampaignRecipientRow = z.infer<typeof campaignRecipientSchema>;

/** One firing that already happened — a row in the Sent log, summarised. */
export const campaignRunSchema = z.object({
  mailoutId: uuid,
  /** which occurrence it was for, `YYYY-MM-DD` */
  periodKey: z.string().nullable(),
  createdAt: z.iso.datetime(),
  sending: z.number().int(),
  sent: z.number().int(),
  delivered: z.number().int(),
  notDelivered: z.number().int(),
  notSent: z.number().int(),
  skipped: z.number().int(),
});
export type CampaignRun = z.infer<typeof campaignRunSchema>;

export const campaignSchema = z.object({
  id: uuid,
  name: z.string(),
  templateId: uuid,
  templateName: z.string(),
  senderAccountId: uuid.nullable(),
  senderAccountName: z.string().nullable(),
  kind: mailoutKind,
  rhythm: campaignRhythm,
  startsOn: z.iso.date(),
  sendAt: z.string(),
  endsOn: z.iso.date().nullable(),
  /** the hand-picked days, earliest first; empty for every rhythm but `dates` */
  dates: z.array(z.iso.date()),
  status: campaignStatus,
  /** the next date due; null once nothing is — finished, or stopped by hand */
  nextRunOn: z.iso.date().nullable(),
  lastRunAt: z.iso.datetime().nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.iso.datetime(),
  recipientCount: z.number().int(),
  runCount: z.number().int(),
});
export type Campaign = z.infer<typeof campaignSchema>;

/**
 * Who unsubscribed *because of this campaign* — the question the firm actually asks about one.
 *
 * Possible because the unsubscribe link carries the letter it came from, and the letter knows its
 * campaign. The opt-out itself stays global: one click stops all commercial mail, whichever
 * campaign prompted it. This says which one did.
 */
export const campaignOptOutSchema = z.object({
  clientId: uuid,
  clientName: z.string(),
  unsubscribedAt: z.iso.datetime(),
  /** which run's letter they clicked, so a monthly campaign can say which month */
  periodKey: z.string().nullable(),
});
export type CampaignOptOut = z.infer<typeof campaignOptOutSchema>;

export const campaignDetailSchema = campaignSchema.extend({
  recipients: z.array(campaignRecipientSchema),
  runs: z.array(campaignRunSchema),
  optOuts: z.array(campaignOptOutSchema),
  /** the letter's text as stored on the template, so the detail can show what will go out */
  subject: z.string(),
  body: z.string(),
});
export type CampaignDetail = z.infer<typeof campaignDetailSchema>;

export const campaignListSchema = z.object({ items: z.array(campaignSchema) });
export type CampaignList = z.infer<typeof campaignListSchema>;

/** Stop a running campaign, or start a stopped one again. `finished` cannot be resumed. */
export const setCampaignActiveInput = z.object({ active: z.boolean() });
export type SetCampaignActiveInput = z.infer<typeof setCampaignActiveInput>;
