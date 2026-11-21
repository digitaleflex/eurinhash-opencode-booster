import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["tests/fuzz/**", "src/core/core.test.ts", "node_modules/", "dist/"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/", "dist/", "**/*.test.ts", "**/*.config.ts", "**/*.config.mts"],
      // Floor, raised as coverage grows (core/core.test.ts runs under Bun and is not counted here).
      thresholds: { statements: 68, lines: 70, functions: 70, branches: 57 },
    },
    globals: true,
    setupFiles: ["tests/setup-env.ts"],
  },
});