import { describe, expect, it } from "vitest";
import { describeDatabase, readSwitch } from "../src/env";

/**
 * Regression: Render's service had FLOWOS_MIGRATE_ON_START set, yet the server skipped migrating
 * and refused to start ("14 migration(s) not applied"): only the exact string "true" turned it on.
 */
describe("on/off switches", () => {
  const read = (value: string | undefined) =>
    readSwitch("FLOWOS_MIGRATE_ON_START", { FLOWOS_MIGRATE_ON_START: value });

  it("accepts the ways a dashboard may store 'on'", () => {
    for (const v of ["true", "True", "TRUE", " true ", "true\n", '"true"', "'true'", "1", "yes", "on", "ON"])
      expect(read(v), JSON.stringify(v)).toEqual({ enabled: true, raw: v });
  });

  it("reads 'off', empty and unset as off", () => {
    for (const v of ["false", "False", "0", "no", "off", "", "  "])
      expect(read(v).enabled, JSON.stringify(v)).toBe(false);
    expect(read(undefined)).toEqual({ enabled: false, raw: undefined });
  });

  it("refuses anything else instead of silently meaning off", () => {
    expect(() => read("ture")).toThrow(
      'FLOWOS_MIGRATE_ON_START must be true or false (1/0, yes/no and on/off also work); got "ture".',
    );
    expect(() => read("enabled")).toThrow("must be true or false");
  });
});

describe("database description for logs", () => {
  it("shows host, port and database name, never the credentials", () => {
    const shown = describeDatabase(
      "postgres://render_user:s3cr3t-pass@dpg-abc123-a:5432/flowos_db?sslmode=require",
    );
    expect(shown).toBe("dpg-abc123-a:5432/flowos_db");
    expect(shown).not.toContain("s3cr3t");
    expect(shown).not.toContain("render_user");
  });
});
