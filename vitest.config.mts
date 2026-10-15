import path from "node:path";

import { defineConfig } from "vitest/config";

const ROOT_DIR = import.meta.dirname;

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    reporters: ["default"],
  },
  resolve: {
    alias: {
      "@": path.resolve(ROOT_DIR, "src"),
      // Vitest runs server modules in Node; Next.js keeps the real client import guard.
      "server-only": path.resolve(ROOT_DIR, "tests/helpers/server-only.ts"),
    },
  },
});
