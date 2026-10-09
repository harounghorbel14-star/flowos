import { describe, expect, it } from "vitest";
import { demoSeedPassword, LOCAL_DEMO_PASSWORD } from "../src/db/seed-guard";

describe("demo seed guard", () => {
  it("uses the documented password only in development and test", () => {
    expect(demoSeedPassword({ NODE_ENV: "development" })).toEqual({
      password: LOCAL_DEMO_PASSWORD,
      documented: true,
    });
    expect(demoSeedPassword({})).toEqual({ password: LOCAL_DEMO_PASSWORD, documented: true });
    expect(demoSeedPassword({ NODE_ENV: "development", FLOWOS_DEMO_PASSWORD: "my-own-pass-1" })).toEqual({
      password: "my-own-pass-1",
      documented: false,
    });
  });

  it("refuses production without the explicit flag", () => {
    expect(() => demoSeedPassword({ NODE_ENV: "production" })).toThrow(/Refusing to seed/);
  });

  it("never allows predictable credentials in production", () => {
    const base = { NODE_ENV: "production", FLOWOS_ALLOW_DEMO_SEED: "true" } as const;
    expect(() => demoSeedPassword(base)).toThrow(/FLOWOS_DEMO_PASSWORD/);
    expect(() => demoSeedPassword({ ...base, FLOWOS_DEMO_PASSWORD: LOCAL_DEMO_PASSWORD })).toThrow();
    expect(() => demoSeedPassword({ ...base, FLOWOS_DEMO_PASSWORD: "short-pass-12" })).toThrow();
    expect(demoSeedPassword({ ...base, FLOWOS_DEMO_PASSWORD: "a-private-staging-passphrase-42" })).toEqual({
      password: "a-private-staging-passphrase-42",
      documented: false,
    });
  });
});
