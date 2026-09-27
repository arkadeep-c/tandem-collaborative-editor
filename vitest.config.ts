import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Import-time env for modules that build (but never connect) a pg Pool.
    env: {
      DATABASE_URL: "postgresql://localhost:5432/vitest",
      SESSION_SECRET: "vitest-secret-vitest-secret-32b",
    },
  },
});
