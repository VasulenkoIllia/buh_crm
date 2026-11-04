import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { uuid } from "@shared/schema/common.js";
import {
  addPaymentInput,
  attachInvoiceInput,
  createInvoiceInput,
  invoiceListQuery,
  invoicePdfQuery,
  lastRateQuery,
  bulkTidyInput,
  bulkDeliveryInput,
  markPaidInput,
  setDeliveryInput,
  unbilledJobsQuery,
  updateInvoiceInput,
  updatePaymentInput,
} from "@shared/schema/payment.js";
import { createInvoiceItemInput } from "@shared/schema/invoice-items.js";
import { gate } from "../../core/access.js";
import { viewHeaders } from "../files/index.js";
import { createInvoiceItem } from "../settings/index.js";
import { attachInvoice, listUnbilledJobs } from "./job-invoices.js";
import { invoicePdf, saveInvoicePdf } from "./payments.pdf.js";
import * as service from "./payments.service.js";

const idParams = z.object({ id: uuid });
const paymentParams = z.object({ paymentId: uuid });

export async function registerRoutes(instance: FastifyInstance) {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  const billing = gate("billing");
  /**
   * Six routes that no gate state can express: correcting an issued invoice, cancelling one,
   * attaching one to a job, and editing or deleting a recorded payment or reading its audit trail.
   * Billing has to stay OPEN —
   * close it and nobody can bill — so "everything here except these six" is a per-ACTION rule,
   * which is stage 2. Carried on the declaration so the one hook still decides, and so each one
   * becomes a row with a real `action` value rather than a rewrite when that day comes.
   *
   * Money already recorded is the reason: a payment that can be quietly edited by whoever took it
   * is not a record of anything.
   */
  const correction = gate("billing", { adminOnly: true });

  // Everyone sees invoices and registers payments (decision 2026-07-25);
  // editing/deleting a payment and cancelling an invoice stay admin-only.

  app.get(
    "/",
    { config: billing, schema: { querystring: invoiceListQuery } },
    async (request) => service.listInvoices(request.query),
  );

  app.post(
    "/",
    { config: billing, schema: { body: createInvoiceInput } },
    async (request, reply) =>
      reply.status(201).send(await service.createInvoice(request.body, request.currentUser!)),
  );

  // static paths before /:id
  app.get(
    "/last-rate",
    { config: billing, schema: { querystring: lastRateQuery } },
    async (request) => service.lastRate(request.query.clientId),
  );

  app.get(
    "/unbilled-jobs",
    { config: billing, schema: { querystring: unbilledJobsQuery } },
    async (request) => listUnbilledJobs(request.query.clientId),
  );

  app.post(
    "/mark-paid",
    { config: billing, schema: { body: markPaidInput } },
    async (request) => service.markPaid(request.body, request.currentUser!),
  );

  app.post(
    "/bulk-delivery",
    { config: billing, schema: { body: bulkDeliveryInput } },
    async (request) => service.setDeliveryMany(request.body, request.currentUser!),
  );

  app.post(
    "/bulk-tidy",
    { config: billing, schema: { body: bulkTidyInput } },
    async (request) => service.setTidied(request.body, request.currentUser!),
  );

  /**
   * **A new invoice item from an invoice's row** (payments.md §3, owner 2026-11-04): whoever bills
   * may add a name to the list the Position box offers, the row's unit and rate with it. Billing's
   * gate, not Settings': Settings is closed to users by default, and they write invoices. Editing,
   * switching off and deleting an item stay on Settings → Invoices. The answer is the whole list,
   * as Settings' own add answers.
   */
  app.post(
    "/items",
    { config: billing, schema: { body: createInvoiceItemInput } },
    async (request, reply) => reply.status(201).send(await createInvoiceItem(request.body)),
  );

  app.patch(
    "/payments/:paymentId",
    { config: correction, schema: { params: paymentParams, body: updatePaymentInput } },
    async (request) =>
      service.updatePayment(request.params.paymentId, request.body, request.currentUser!),
  );

  app.delete(
    "/payments/:paymentId",
    { config: correction, schema: { params: paymentParams } },
    async (request) => service.removePayment(request.params.paymentId, request.currentUser!),
  );

  app.get("/:id", { config: billing, schema: { params: idParams } }, async (request) =>
    service.getInvoice(request.params.id),
  );

  /**
   * The same headers a stored PDF leaves with (files.md §12.2). `download=1` saves it instead of
   * opening it; the bytes do not differ.
   */
  app.get(
    "/:id/pdf",
    { config: billing, schema: { params: idParams, querystring: invoicePdfQuery } },
    async (request, reply) => {
      const { name, buffer } = await invoicePdf(request.params.id);
      const headers = viewHeaders({ name, detectedMime: "application/pdf" }) ?? {};
      for (const [header, value] of Object.entries(headers)) reply.header(header, value);
      if (request.query.download) {
        reply.header(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        );
      }
      return reply.send(buffer);
    },
  );

  app.post(
    "/:id/save-pdf",
    { config: billing, schema: { params: idParams } },
    async (request) => saveInvoicePdf(request.params.id, request.currentUser!),
  );

  // correcting an issued invoice is a money change → admin, journalled
  app.patch(
    "/:id",
    { config: correction, schema: { params: idParams, body: updateInvoiceInput } },
    async (request) =>
      service.updateInvoice(request.params.id, request.body, request.currentUser!),
  );

  app.post(
    "/:id/payments",
    { config: billing, schema: { params: idParams, body: addPaymentInput } },
    async (request, reply) =>
      reply
        .status(201)
        .send(await service.addPayment(request.params.id, request.body, request.currentUser!)),
  );

  // any user may mark an invoice as sent — they're the ones handing it over
  app.post(
    "/:id/delivery",
    { config: billing, schema: { params: idParams, body: setDeliveryInput } },
    async (request) =>
      service.setDelivery(request.params.id, request.body, request.currentUser!),
  );

  app.post(
    "/:id/cancel",
    { config: correction, schema: { params: idParams } },
    async (request) => service.cancelInvoice(request.params.id, request.currentUser!),
  );

  // changes what an invoice already issued stands for, maybe already with the client → admin.
  // Issuing one on a job moves the price too, and is open: that paper did not exist yet
  app.post(
    "/:id/attach-job",
    { config: correction, schema: { params: idParams, body: attachInvoiceInput } },
    async (request) => {
      await attachInvoice(request.params.id, request.body.taskId);
      return service.getInvoice(request.params.id);
    },
  );

  // who changed which payment, before → after
  app.get("/:id/audit", { config: correction, schema: { params: idParams } }, async (request) =>
    service.listAudit(request.params.id),
  );
}
