import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      output: {
        /**
         * The framework in its own file, so a deploy does not re-download it.
         *
         * Screens are already split per route (`src/app/router.tsx`), but React, the router and
         * the query client end up in whichever chunk loads first — and that chunk changes on every
         * deploy, so everyone re-downloads ~150 kB of unchanged library each time. Named here, it
         * gets a hash of its own and stays in the browser cache across releases; only the app code
         * a release actually touched is fetched again (2026-09-01).
         */
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          query: ["@tanstack/react-query"],
          zod: ["zod"],
          dnd: ["@dnd-kit/core", "@dnd-kit/sortable", "@dnd-kit/utilities"],
          forms: ["react-hook-form", "@hookform/resolvers"],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // same-origin in dev: API + health go through Vite (no CORS, Origin check stays strict)
      "/api": "http://localhost:3000",
      "/health": "http://localhost:3000",
    },
  },
});
