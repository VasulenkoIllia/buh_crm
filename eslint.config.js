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
              message:
                "Import other modules only via their index.ts (module public surface).",
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
              message:
                "Import other modules only via their index.ts (module public surface).",
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
              message:
                "Import other modules only via their index.ts (module public surface).",
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
