import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      include: [
        "packages/*/src/**/*.ts",
        "apps/server/src/**/*.ts",
        "apps/web/src/lib/**/*.ts",
      ],
      exclude: ["**/*.test.ts", "**/*.d.ts"],
      reporter: ["text"],
      thresholds: { lines: 70 },
    },
    include: [
      "packages/*/test/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      "plugins/*/tests/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
