import js from "@eslint/js";
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
              group: ["**/modules/*/*", "!**/modules/*/index"],
              message:
                "Import other modules only via their index.ts (module public surface).",
            },
          ],
        },
      ],
    },
  },
);
