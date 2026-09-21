import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "design/", "coverage/", "templates/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Module boundaries: import other modules only via their index (public surface)
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "modules/[^/]+/(?!index(\\.js)?$)[^/]+$",
              message: "Import other modules only via their index.ts (module public surface).",
            },
          ],
        },
      ],
    },
  },
  {
    // hooks discipline — catches conditional hooks (the past LeadDetails-class bug) in CI
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // inside a module, cross-module RELATIVE imports must also go via index
    files: ["server/modules/**", "src/modules/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "modules/[^/]+/(?!index(\\.js)?$)[^/]+$",
              message: "Import other modules only via their index.ts (module public surface).",
            },
            {
              regex: "^\\.\\./[^./][^/]*/(?!index(\\.js)?$)[^/]+$",
              message:
                "Import sibling modules only via their index.ts (module public surface).",
            },
          ],
        },
      ],
    },
  },
  {
    /**
     * **A clickable thing in a module goes through the shared set** (design-system.md).
     *
     * An audit on 2026-09-20 found 233 hand-rolled clickables in `src/modules` against 268 using
     * the components — 47% bypassing them — which is how the same action came to be a word here
     * and an icon there, how destructive ended up with five treatments, and how `focus-visible`
     * appeared three times in the whole of `src/`. Waves of migration fix what is there; this is
     * what keeps it fixed, because the set drifted back once already.
     *
     * `Button`, `IconButton`, `RowButton`, `ClearButton`, `CopyLink`, `Menu`, `Segmented`,
     * `FilterChips` and `Tabs` cover every kind of action the CRM has — they are all on `/ui`.
     * A genuinely new shape belongs in `src/shared/ui/`, where everybody gets it; a one-off that
     * truly is one-off says so with a comment and this line:
     *
     *     {/* eslint-disable-next-line no-restricted-syntax -- <why this is not a Button> *\/}
     *
     * **`ignores` is the migration, written down.** 55 files still hold one on 2026-09-21,
     * and each wave takes some off this list — a shrinking list is a visible diff, where a
     * warning nobody counts is not. A file NOT on it is held to the rule from its first line,
     * which is the half that matters: what is already clean cannot drift back, and nothing new
     * starts dirty.
     */
    files: ["src/modules/**/*.tsx"],
    ignores: [
      "src/modules/activity/activity-feed.tsx",
      "src/modules/activity/activity-policies.tsx",
      "src/modules/auth/sign-in.page.tsx",
      "src/modules/calendar/calendar.page.tsx",
      "src/modules/calendar/entity-meetings.tsx",
      "src/modules/calendar/meeting-modal.tsx",
      "src/modules/catalog/services.page.tsx",
      "src/modules/catalog/task-rhythm-fields.tsx",
      "src/modules/chat/attachments.tsx",
      "src/modules/chat/chat-files-tab.tsx",
      "src/modules/chat/chat-list.tsx",
      "src/modules/chat/chat-panel.tsx",
      "src/modules/chat/chat-search.tsx",
      "src/modules/chat/chat.page.tsx",
      "src/modules/chat/composer.tsx",
      "src/modules/chat/conversation.tsx",
      "src/modules/chat/emoji-picker.tsx",
      "src/modules/chat/mentions.tsx",
      "src/modules/chat/message-menu.tsx",
      "src/modules/chat/message-row.tsx",
      "src/modules/chat/pinned-bar.tsx",
      "src/modules/chat/poll.tsx",
      "src/modules/clients/client-card.page.tsx",
      "src/modules/clients/client-form.tsx",
      "src/modules/clients/client-services.tsx",
      "src/modules/clients/clients.page.tsx",
      "src/modules/files/dialogs.tsx",
      "src/modules/files/folder-pane.tsx",
      "src/modules/files/library.tsx",
      "src/modules/files/other-panes.tsx",
      "src/modules/files/pane-parts.tsx",
      "src/modules/files/search-pane.tsx",
      "src/modules/files/tree.tsx",
      "src/modules/files/upload-queue.tsx",
      "src/modules/leads/leads.page.tsx",
      "src/modules/mailouts/campaign-modal.tsx",
      "src/modules/mailouts/recipient-picker.tsx",
      "src/modules/mailouts/sender-account-modal.tsx",
      "src/modules/mailouts/template-modal.tsx",
      "src/modules/notifications/notification-policy.tsx",
      "src/modules/notifications/notification-preferences.tsx",
      "src/modules/notifications/notification-tray.tsx",
      "src/modules/payments/billing.page.tsx",
      "src/modules/payments/invoice-modals.tsx",
      "src/modules/secrets/entry.tsx",
      "src/modules/secrets/forms.tsx",
      "src/modules/secrets/move.tsx",
      "src/modules/secrets/panes.tsx",
      "src/modules/secrets/vault.tsx",
      "src/modules/settings/access-section.tsx",
      "src/modules/settings/settings.page.tsx",
      "src/modules/tasks/task-controls.tsx",
      "src/modules/tasks/task-modals.tsx",
      "src/modules/tasks/tasks.page.tsx",
      "src/modules/tasks/timer.tsx",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXOpeningElement[name.name='button']",
          message:
            "Use the shared controls (Button, IconButton, RowButton, ClearButton — see /ui) " +
            "rather than a raw <button>. A new shape belongs in src/shared/ui/.",
        },
      ],
    },
  },
  {
    /**
     * One-off scripts are not modules, and the boundary rule is about MODULES.
     *
     * `scripts/dev/seed-notifications.ts` fills a developer's bell by driving `createTask`,
     * `updateMeeting` and the notification sweep directly — deliberately the same functions the
     * routes call, so what lands in the tray is produced by the real code. The alternative was to
     * widen four module barrels for a fixture nobody ships, which is exactly the "a wider barrel
     * is more of the module reachable from anywhere" failure the rule exists to prevent.
     *
     * Nothing here is bundled or deployed: `scripts/` is run by hand with tsx.
     */
    files: ["scripts/**/*.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    // Layering (architecture.md §3): routes → service → repository → Prisma. Only a module's
    // repository holds queries, so schema knowledge stays in one file per module and a query is
    // never hidden inside business logic. Type-only imports from the generated client are fine.
    files: ["server/**/*.ts"],
    ignores: [
      "server/core/**", // core owns the client, sessions, bootstrap and the uploads/mail boundaries
      "server/server.ts", // the entry point closes the connection on shutdown
      "server/**/*.repository.ts",
      "server/**/*.test.ts", // tests seed and assert against the database directly
      // test infrastructure is part of the suite, not a layer of the app: the setup file that
      // registers the route log, and the check that reads it after the run
      "server/test/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "core/db(\\.js)?$",
              message:
                "Database access belongs in the module's <module>.repository.ts (architecture.md §3).",
            },
            {
              regex: "modules/[^/]+/(?!index(\\.js)?$)[^/]+$",
              message: "Import other modules only via their index.ts (module public surface).",
            },
            {
              regex: "^\\.\\./[^./][^/]*/(?!index(\\.js)?$)[^/]+$",
              message:
                "Import sibling modules only via their index.ts (module public surface).",
            },
          ],
        },
      ],
    },
  },
);
