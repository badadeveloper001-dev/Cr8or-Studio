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
    },
  },
});
