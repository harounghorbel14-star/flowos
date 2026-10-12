import { defineConfig } from "vitest/config";
import base from "./vitest.config";

// Live tests call a real inference runtime (self-hosted or, if configured, hosted); never part of `npm test`.
export default defineConfig({
  ...base,
  test: { ...base.test, include: ["server/test-live/**/*.live.test.ts"], testTimeout: 360_000 },
});
