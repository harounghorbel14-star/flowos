import { defineConfig } from "vitest/config";
import base from "./vitest.config";

// Live tests call the real Anthropic API; they never run as part of `npm test`.
export default defineConfig({
  ...base,
  test: { ...base.test, include: ["server/test-live/**/*.live.test.ts"], testTimeout: 360_000 },
});
