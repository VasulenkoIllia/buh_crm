import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
  test: {
    include: ["server/**/*.test.ts", "shared/**/*.test.ts", "src/**/*.test.ts?(x)"],
    environment: "node",
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://buh_crm:buh_crm_dev@localhost:5432/buh_crm_test",
      SESSION_SECRET: "test-session-secret-0123456789",
      LOG_LEVEL: "silent",
    },
  },
});
