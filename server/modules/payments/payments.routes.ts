import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { uuid } from "@shared/schema/common.js";
import {
  addPaymentInput,
  createInvoiceInput,
  invoiceListQuery,
  bulkTidyInput,
  bulkDeliveryInput,
  markPaidInput,
  setDeliveryInput,
  updateInvoiceInput,
  updatePaymentInput,
} from "@shared/schema/payment.js";
import { requireAdmin, requireAuth } from "../../core/auth.js";
import * as service from "./payments.service.js";

const idParams = z.object({ id: uuid });
const paymentParams = z.object({ paymentId: uuid });

export async function registerRoutes(instance: FastifyInstance) {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  // Everyone sees invoices and registers payments (decision 2026-07-25);
  // editing/deleting a payment and cancelling an invoice stay admin-only.

  app.get(
    "/",
    { preHandler: requireAuth, schema: { querystring: invoiceListQuery } },
    async (request) => service.listInvoices(request.query),
  );

  app.post(
    "/",
    { preHandler: requireAuth, schema: { body: createInvoiceInput } },
    async (request, reply) =>
      reply.status(201).send(await service.createInvoice(request.body, request.currentUser!)),
  );

  // static paths before /:id
  app.post(
    "/mark-paid",
    { preHandler: requireAuth, schema: { body: markPaidInput } },
    async (request) => service.markPaid(request.body, request.currentUser!),
  );

  app.post(
    "/bulk-delivery",
    { preHandler: requireAuth, schema: { body: bulkDeliveryInput } },
    async (request) => service.setDeliveryMany(request.body, request.currentUser!),
  );

  app.post(
    "/bulk-tidy",
    { preHandler: requireAuth, schema: { body: bulkTidyInput } },
    async (request) => service.setTidied(request.body, request.currentUser!),
  );

  app.patch(
    "/payments/:paymentId",
    { preHandler: requireAdmin, schema: { params: paymentParams, body: updatePaymentInput } },
    async (request) =>
      service.updatePayment(request.params.paymentId, request.body, request.currentUser!),
  );

  app.delete(
    "/payments/:paymentId",
    { preHandler: requireAdmin, schema: { params: paymentParams } },
    async (request) => service.removePayment(request.params.paymentId, request.currentUser!),
  );

  app.get("/:id", { preHandler: requireAuth, schema: { params: idParams } }, async (request) =>
    service.getInvoice(request.params.id),
  );

  // correcting an issued invoice is a money change → admin, journalled
  app.patch(
    "/:id",
    { preHandler: requireAdmin, schema: { params: idParams, body: updateInvoiceInput } },
    async (request) => service.updateInvoice(request.params.id, request.body, request.currentUser!),
  );

  app.post(
    "/:id/payments",
    { preHandler: requireAuth, schema: { params: idParams, body: addPaymentInput } },
    async (request, reply) =>
      reply
        .status(201)
        .send(await service.addPayment(request.params.id, request.body, request.currentUser!)),
  );

  // any user may mark an invoice as sent — they're the ones handing it over
  app.post(
    "/:id/delivery",
    { preHandler: requireAuth, schema: { params: idParams, body: setDeliveryInput } },
    async (request) => service.setDelivery(request.params.id, request.body, request.currentUser!),
  );

  app.post(
    "/:id/cancel",
    { preHandler: requireAdmin, schema: { params: idParams } },
    async (request) => service.cancelInvoice(request.params.id, request.currentUser!),
  );

  // who changed which payment, before → after
  app.get(
    "/:id/audit",
    { preHandler: requireAdmin, schema: { params: idParams } },
    async (request) => service.listAudit(request.params.id),
  );
}
