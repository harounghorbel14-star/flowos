import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@server": path.resolve(import.meta.dirname, "server/src"),
    },
  },
  test: {
    include: ["server/test/**/*.test.ts", "shared/**/*.test.ts", "client/src/**/*.test.{ts,tsx}"],
    globalSetup: ["server/test/globalSetup.ts"],
    setupFiles: ["server/test/setupEnv.ts"],
    // Integration tests share one Postgres database; run files serially.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
