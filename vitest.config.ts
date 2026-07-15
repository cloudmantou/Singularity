import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "public/utils.js"],
      exclude: ["src/server.ts"],
      reporter: ["text", "html", "json-summary", "json"],
      reportsDirectory: "coverage",
      thresholds: {
        statements: 80,
        branches: 70,
        lines: 80,
        functions: 80,
      },
    },
  },
});
