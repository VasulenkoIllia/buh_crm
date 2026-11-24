/**
 * Who a meeting is with, as the rows a notification LETTER carries under the account (owner,
 * 2026-11-24: a letter about a meeting said only its title).
 *
 * In core because two modules raise meeting notices, Meetings for the lifecycle and Notifications
 * for the morning and reminder sweeps, and neither may import the other.
 *
 * The contact follows the meeting form's rule (`meeting-modal.tsx`): the named person when there
 * is one, else the client, else the lead. Nothing here goes further than that form: whoever can
 * open the meeting reads the same name, phone and email there, since `GET /api/clients/:id` is
 * `shared()`. Only the letter carries these rows; the tray keeps its one line.
 */
import type { Prisma } from "../generated/prisma/client.js";
import { clientCode } from "@shared/schema/client.js";
import type { EmailTemplates } from "./email.js";
import { clientLabel } from "./names.js";

/** What a meeting query selects so its rows can be handed to `meetingFacts`. */
export const meetingPartySelect = {
  client: {
    select: {
      code: true,
      firstName: true,
      lastName: true,
      companyName: true,
      phone: true,
      email: true,
    },
  },
  lead: { select: { name: true, companyName: true, phone: true, email: true } },
  person: { select: { name: true, phone: true, email: true } },
} satisfies Prisma.MeetingSelect;

export type MeetingParty = Prisma.MeetingGetPayload<{ select: typeof meetingPartySelect }>;

type LetterFacts = NonNullable<EmailTemplates["notification"]["facts"]>;

/** An internal meeting has nobody on the other side, and its letter stays as it was. */
export function meetingFacts(meeting: MeetingParty): LetterFacts {
  const { client, lead, person } = meeting;
  if (!client && !lead) return [];

  const contact = person ?? client ?? lead;
  const rows: Array<[label: string, value: string | null | undefined]> = [
    client
      ? ["Client", `${clientLabel(client)} · ${clientCode(client.code)}`]
      : ["Lead", lead?.name],
    ["Company", client ? client.companyName : lead?.companyName],
    ["Contact", person?.name],
    ["Phone", contact?.phone],
    ["Email", contact?.email],
  ];
  return rows.flatMap(([label, value]) =>
    value?.trim() ? [{ label, value: value.trim() }] : [],
  );
}
