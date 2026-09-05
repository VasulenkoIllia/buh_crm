import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { uuid } from "@shared/schema/common.js";
import {
  createTemplateInput,
  mailoutListQuery,
  previewLetterInput,
  previewMailoutInput,
  senderTestInput,
  sendMailoutInput,
  setSubscriptionInput,
  senderAccountInput,
  updateFirmMailInput,
  updateTemplateInput,
} from "@shared/schema/mailouts.js";
import { anonymous, gate } from "../../core/access.js";
import { ValidationError } from "../../core/errors.js";
import { readFileStream } from "../../core/files.js";
import * as service from "./mailouts.service.js";

const idParams = z.object({ id: uuid });
const clientParams = z.object({ clientId: uuid });
const tokenParams = z.object({ token: z.string().min(10).max(200) });

/**
 * Which letter the link came from — provenance only, never a credential.
 *
 * Optional and forgiving on purpose: letters already in inboxes carry no `m`, and a mangled one
 * must cost the client nothing. The service verifies the claim before storing it.
 */
const unsubscribeQuery = z.object({ m: uuid.optional().catch(undefined) });

type UnsubscribeState = "confirm" | "done" | "invalid";

export async function registerRoutes(instance: FastifyInstance) {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  const mailouts = gate("mailouts");
  /**
   * **Its own gate, split out of Mail-outs deliberately.** Sending a letter and rewriting the
   * credentials the firm's mail leaves from are not one privilege — and one of these accounts
   * carries `isInvoiceSender`, so whoever holds it holds where invoices come from. Riding that on
   * the Mail-outs switch is the only failure in this design a client would notice before the firm
   * did.
   */
  const mailboxes = gate("mailboxes");

  // ── the public unsubscribe pages ──────────────────────────────────────────
  //
  // The only unauthenticated routes in the module, and the only place the app answers HTML rather
  // than JSON. They live in their own `register()` scope so the two concessions below apply to
  // these two routes and nothing else.
  //
  // GET renders a confirmation form; only POST unsubscribes. That split is load-bearing: corporate
  // mail scanners fetch every link in an incoming message, so a GET that mutated would unsubscribe
  // clients who never opened the letter. POST also satisfies RFC 8058 one-click, which is what the
  // `List-Unsubscribe-Post` header on each letter promises.
  await instance.register(async (pub) => {
    // Concession 1 — accept `application/x-www-form-urlencoded`.
    //
    // The rest of the API is JSON-only, and Fastify answers 415 to anything else. But BOTH real
    // callers of this route send form encoding: an HTML `<form method="post">` (our own
    // confirmation page) and RFC 8058 one-click, whose body is literally
    // `List-Unsubscribe=One-Click`. Without this parser the unsubscribe link is a 415 for every
    // actual mail client, however well it works from a test harness that sends no Content-Type.
    //
    // The body is never read — the token in the path is the whole request — so it is parsed to
    // `undefined` rather than decoded.
    pub.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_req, _body, done) => done(null, undefined),
    );

    const page = (
      request: { params: { token: string }; query: { m?: string } },
      reply: FastifyReply,
      state: UnsubscribeState,
      firmName: string,
    ) => {
      reply.header("Content-Type", "text/html; charset=utf-8");
      return reply.send(
        service.unsubscribePage({
          token: request.params.token,
          firmName,
          state,
          fromMailoutId: request.query.m ?? null,
        }),
      );
    };

    pub
      .withTypeProvider<ZodTypeProvider>()
      .get(
        "/unsubscribe/:token",
        { config: anonymous(), schema: { params: tokenParams, querystring: unsubscribeQuery } },
        async (request, reply) => {
          const [known, firmName] = await Promise.all([
            service.unsubscribeTokenExists(request.params.token),
            service.senderDisplayName(),
          ]);
          return page(request, reply, known ? "confirm" : "invalid", firmName);
        },
      );

    pub.withTypeProvider<ZodTypeProvider>().post(
      "/unsubscribe/:token",
      {
        // Concession 2 — skip the app-wide Origin check (see the hook in server/app.ts).
        //
        // That check defends session-cookie routes against a cross-site form post. This route
        // carries no session: the unguessable token IS the credential, and nothing an attacker
        // could forge gets them one. All the check can do here is 403 a legitimate unsubscribe
        // whose Origin is the webmail the client is reading in.
        config: { ...anonymous(), skipOriginCheck: true },
        schema: { params: tokenParams, querystring: unsubscribeQuery },
      },
      async (request, reply) => {
        const firmName = await service.senderDisplayName();
        let state: UnsubscribeState = "done";
        try {
          await service.unsubscribeByToken(request.params.token, request.query.m ?? null);
        } catch {
          state = "invalid";
        }
        return page(request, reply, state, firmName);
      },
    );
  });

  // ── templates ─────────────────────────────────────────────────────────────

  app.get("/templates", { config: mailouts }, async () => service.listTemplates());

  app.post(
    "/templates",
    { config: mailouts, schema: { body: createTemplateInput } },
    async (request, reply) =>
      reply.status(201).send(await service.createTemplate(request.body)),
  );

  app.patch(
    "/templates/:id",
    { config: mailouts, schema: { params: idParams, body: updateTemplateInput } },
    async (request) => service.updateTemplate(request.params.id, request.body),
  );

  app.delete(
    "/templates/:id",
    { config: mailouts, schema: { params: idParams } },
    async (request, reply) => {
      await service.deleteTemplate(request.params.id);
      return reply.status(204).send();
    },
  );

  // ── preview and send ──────────────────────────────────────────────────────

  // "what does this letter look like" — sample values, no recipients. Registered before
  // `/preview` is irrelevant (static segments differ), but it is the one the template editor uses.
  app.post(
    "/preview/letter",
    { config: mailouts, schema: { body: previewLetterInput } },
    async (request) => service.previewLetter(request.body),
  );

  // "who will actually get this" — needs the chosen clients
  app.post(
    "/preview",
    { config: mailouts, schema: { body: previewMailoutInput } },
    async (request) => service.preview(request.body),
  );

  app.post(
    "/send",
    { config: mailouts, schema: { body: sendMailoutInput } },
    async (request, reply) =>
      reply.status(201).send(await service.send(request.currentUser!, request.body)),
  );

  // ── the log ───────────────────────────────────────────────────────────────

  app.get(
    "/",
    { config: mailouts, schema: { querystring: mailoutListQuery } },
    async (request) => service.list(request.query),
  );

  app.get("/:id", { config: mailouts, schema: { params: idParams } }, async (request) =>
    service.detail(request.params.id),
  );

  // ── the client card ───────────────────────────────────────────────────────

  app.get(
    "/clients/:clientId",
    {
      config: mailouts,
      schema: { params: clientParams, querystring: mailoutListQuery },
    },
    async (request) => service.clientState(request.params.clientId, request.query),
  );

  /**
   * One letter as this client received it. Registered under the CLIENT, so the scoping is in the
   * URL rather than in a filter someone can forget.
   *
   * Addressed by RECIPIENT ROW, not by mailout: one mailout may reach the same client at their own
   * address and at each of their companies, and those letters differ — `{{company}}` names a
   * different business in each.
   */
  app.get(
    "/clients/:clientId/letters/:letterId",
    {
      config: mailouts,
      schema: { params: clientParams.extend({ letterId: uuid }) },
    },
    async (request) => service.clientLetter(request.params.letterId, request.params.clientId),
  );

  app.patch(
    "/clients/:clientId/subscription",
    { config: mailouts, schema: { params: clientParams, body: setSubscriptionInput } },
    async (request) =>
      service.setSubscription(
        request.currentUser!,
        request.params.clientId,
        request.body.subscribed,
      ),
  );

  /**
   * Un-block an address. Kept beside the subscription toggle because both answer the same
   * question — may we write to this client — and both belong to whoever is reading their card.
   */
  app.post(
    "/clients/:clientId/addresses/revive",
    {
      config: mailouts,
      schema: { params: clientParams, body: z.object({ email: z.string() }) },
    },
    async (request) =>
      service.reviveAddress(request.currentUser!, request.params.clientId, request.body.email),
  );

  // ── sender mailboxes ──────────────────────────────────────────────────────
  //
  // The FULL state — SMTP and IMAP hostnames and usernames included — so it sits behind the
  // `mailboxes` gate, reads and writes alike. The composer does not call this: it calls
  // `GET /senders` below, which answers with names and addresses only, so closing the mailbox
  // editor cannot take the From picker down with it.

  /**
   * **The From picker — names and addresses, nothing else.**
   *
   * Added on 2026-09-07 with the gates. Three screens inside Mail-outs need to know which mailbox
   * a send will leave from, and until now all three called the editor's endpoint, which answers
   * with `smtpHost`, `smtpUser`, `imapHost` and `imapUser`. Closing the `mailboxes` gate would
   * then have taken the composer down with the editor — and leaving it open means every letter
   * anyone composes ships the firm's mail credentials to the browser to fill a dropdown.
   *
   * So the picker is its own read, on the Mail-outs gate. `GET /settings/senders` keeps the full
   * state and the mailbox gate. This is the first of the narrow reference reads §9 records as
   * stage 1.5, done here because a gate would otherwise be broken by it.
   */
  app.get("/senders", { config: mailouts }, async () => service.listSenderOptions());

  app.get("/settings/senders", { config: mailboxes }, async () =>
    service.listSenderAccounts(),
  );

  app.post(
    "/settings/senders",
    { config: mailboxes, schema: { body: senderAccountInput } },
    async (request, reply) =>
      reply.status(201).send(await service.createSenderAccount(request.body)),
  );

  app.patch(
    "/settings/senders/:id",
    { config: mailboxes, schema: { params: idParams, body: senderAccountInput } },
    async (request) => service.updateSenderAccount(request.params.id, request.body),
  );

  app.post(
    "/settings/senders/:id/default",
    { config: mailboxes, schema: { params: idParams } },
    async (request) => service.makeSenderAccountDefault(request.params.id),
  );

  app.post(
    "/settings/senders/:id/invoice-sender",
    { config: mailboxes, schema: { params: idParams } },
    async (request) => service.makeInvoiceSender(request.params.id),
  );

  app.delete(
    "/settings/senders/:id",
    { config: mailboxes, schema: { params: idParams } },
    async (request) => service.deleteSenderAccount(request.params.id),
  );

  // Prove a mailbox rather than believe it: a real handshake, and optionally a real letter to the
  // admin's own address. Admin-only — it opens an outbound connection with stored credentials.
  app.post(
    "/settings/senders/:id/test",
    { config: mailboxes, schema: { params: idParams, body: senderTestInput } },
    async (request) =>
      service.testSenderAccount(request.currentUser!, request.params.id, request.body),
  );

  /**
   * The letterhead mark, uploaded here rather than in Settings.
   *
   * Its own file on purpose: the sidebar logo and the letterhead have different jobs, and sharing
   * one would mean restyling the app silently restyles what clients receive.
   */
  // Behind auth like every other upload — the letter embeds its own copy, so nothing public
  // needs to reach this.
  app.get("/settings/mail-logo", { config: mailouts }, async (_request, reply) => {
    const file = await service.getMailLogoFile();
    reply.header("Content-Type", file.mime);
    reply.header("Cache-Control", "private, max-age=60");
    return reply.send(readFileStream(file.path));
  });

  app.put("/settings/mail-logo", { config: mailboxes }, async (request) => {
    const part = await request.file();
    if (!part) throw new ValidationError("Choose an image file");
    return service.setMailLogo(request.currentUser!, {
      buffer: await part.toBuffer(),
      filename: part.filename,
      mimetype: part.mimetype,
    });
  });

  app.delete("/settings/mail-logo", { config: mailboxes }, async () =>
    service.removeMailLogo(),
  );

  /** The firm's postal address — one address for the firm, never per mailbox. */
  app.patch(
    "/settings/firm-mail",
    { config: mailboxes, schema: { body: updateFirmMailInput } },
    async (request) => service.updateFirmMail(request.body),
  );
}
