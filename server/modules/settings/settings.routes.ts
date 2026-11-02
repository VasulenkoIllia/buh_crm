import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { uuid } from "@shared/schema/common.js";
import {
  createSourceInput,
  swapPrioritiesInput,
  updateFirmInput,
  updateInvoiceDetailsInput,
  updateNumberingInput,
  updatePriorityInput,
  updateSourceInput,
} from "@shared/schema/settings.js";
import {
  createPaymentDetailsInput,
  updatePaymentDetailsInput,
} from "@shared/schema/payment-details.js";
import { gate, shared } from "../../core/access.js";
import { ValidationError } from "../../core/errors.js";
import { readStoredFile } from "../../core/files.js";
import { storageReport } from "../files/index.js";
import * as paymentDetails from "./payment-details.service.js";
import * as service from "./settings.service.js";

const idParams = z.object({ id: uuid });

export async function registerRoutes(instance: FastifyInstance) {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  // everyone (forms elsewhere read priorities/sources/firm from here)
  app.get("/", { config: shared() }, async () => {
    return service.getSettings();
  });

  app.get("/firm/logo", { config: shared() }, async (_request, reply) => {
    const file = await service.getLogoFile();
    reply.header("Content-Type", file.mime);
    reply.header("Cache-Control", "private, max-age=300");
    return reply.send(await readStoredFile(file));
  });

  // ── the `settings` gate: everything below follows it, except numbering ────

  // static route — registered alongside /priorities/:id (static segments win routing)
  app.patch(
    "/priorities/swap",
    { config: gate("settings"), schema: { body: swapPrioritiesInput } },
    async (request) => {
      return service.swapPriorities(request.body.aId, request.body.bId);
    },
  );

  app.patch(
    "/priorities/:id",
    { config: gate("settings"), schema: { params: idParams, body: updatePriorityInput } },
    async (request) => {
      return service.updatePriority(request.params.id, request.body);
    },
  );

  app.post(
    "/sources",
    { config: gate("settings"), schema: { body: createSourceInput } },
    async (request, reply) => {
      const source = await service.createSource(request.body);
      return reply.status(201).send(source);
    },
  );

  app.patch(
    "/sources/:id",
    { config: gate("settings"), schema: { params: idParams, body: updateSourceInput } },
    async (request) => {
      return service.updateSource(request.params.id, request.body);
    },
  );

  /**
   * Only while nothing records it — the service says how many do, and both foreign keys are
   * RESTRICT so the database refuses regardless of who asks first.
   */
  app.delete(
    "/sources/:id",
    { config: gate("settings"), schema: { params: idParams } },
    async (request) => {
      return service.removeSource(request.params.id);
    },
  );

  app.patch(
    "/firm",
    { config: gate("settings"), schema: { body: updateFirmInput } },
    async (request) => {
      return service.updateFirm(request.body);
    },
  );

  /**
   * **Its own route, and admin-only inside an open Settings.**
   *
   * The prefix is frozen into `Invoice.number` at issue and no route can edit it afterwards, so a
   * careless change mid-year splits the accounting year across two series permanently. While it
   * rode on `PATCH /firm`, that made the whole `settings` gate unsafe to open to anybody — which
   * is the open question `modules/permissions.md` §16 recorded, answered here.
   */
  app.patch(
    "/numbering",
    { config: gate("settings", { adminOnly: true }), schema: { body: updateNumberingInput } },
    async (request) => {
      return service.updateNumbering(request.body);
    },
  );

  /**
   * The sender an invoice prints (`shared/schema/settings.ts`). Not on `GET /`, which is `shared()`.
   * Read with the Settings gate, written by an admin. The bank account moved to the payment details
   * sets below on 2026-11-02.
   */
  app.get("/invoice-details", { config: gate("settings") }, async () => {
    return service.getInvoiceDetails();
  });

  app.patch(
    "/invoice-details",
    {
      config: gate("settings", { adminOnly: true }),
      schema: { body: updateInvoiceDetailsInput },
    },
    async (request) => {
      return service.updateInvoiceDetails(request.body);
    },
  );

  /**
   * **Payment details sets** (payments.md §10): where clients send their money. The text is read
   * with the Settings gate, as the invoice details are, and every write is an admin's whoever holds
   * Settings, because whoever edits these decides which account a client pays into.
   */
  app.get("/payment-details", { config: gate("settings") }, async () =>
    paymentDetails.listPaymentDetails(),
  );

  /**
   * Names only, for the client card's select and the line in New invoice, which are not Settings'
   * screens. `shared()`, so it must never carry the text: that stays behind the gate above.
   */
  app.get("/payment-details/options", { config: shared() }, async () =>
    paymentDetails.listPaymentDetailsOptions(),
  );

  const paymentDetailsWrite = gate("settings", { adminOnly: true });

  app.post(
    "/payment-details",
    { config: paymentDetailsWrite, schema: { body: createPaymentDetailsInput } },
    async (request, reply) =>
      reply.status(201).send(await paymentDetails.createPaymentDetails(request.body)),
  );

  app.patch(
    "/payment-details/:id",
    {
      config: paymentDetailsWrite,
      schema: { params: idParams, body: updatePaymentDetailsInput },
    },
    async (request) => paymentDetails.updatePaymentDetails(request.params.id, request.body),
  );

  app.post(
    "/payment-details/:id/default",
    { config: paymentDetailsWrite, schema: { params: idParams } },
    async (request) => paymentDetails.makePaymentDetailsDefault(request.params.id),
  );

  app.post(
    "/payment-details/:id/archive",
    { config: paymentDetailsWrite, schema: { params: idParams } },
    async (request) => paymentDetails.archivePaymentDetails(request.params.id),
  );

  /**
   * Admin-only: it names every background job and the last error text each one produced, which is
   * internal plumbing rather than anything a bookkeeper needs, and an error message is the kind of
   * string that quotes a host or a query back at you. Declared so since S17 (files.md §11.1);
   * before, only `settings`' default of closed kept it an admin's.
   */
  app.get("/system", { config: gate("settings", { adminOnly: true }) }, async () => {
    return service.getSystemHealth();
  });

  /**
   * **Settings → System → Storage** (files.md §4.4): everything the firm stores, and the disk it
   * grows on. Its own route rather than a field on `/system`, and an admin's: the figures are
   * firm-wide and ignore who may see what, so they stay closed to a bookkeeper even where a firm
   * opens Settings to one.
   */
  app.get("/storage", { config: gate("settings", { adminOnly: true }) }, async () =>
    storageReport(),
  );

  app.put("/firm/logo", { config: gate("settings") }, async (request) => {
    const part = await request.file();
    if (!part) throw new ValidationError("Logo file is required");
    const buffer = await part.toBuffer();
    return service.setLogo(request.currentUser!, {
      buffer,
      filename: part.filename,
      mimetype: part.mimetype,
    });
  });
}
