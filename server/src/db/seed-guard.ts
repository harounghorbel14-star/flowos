/** The documented local-only demo password. Never accepted outside development and test. */
export const LOCAL_DEMO_PASSWORD = "flowos-demo-2026";

/**
 * Decide whether demo data may be seeded and with which password.
 * - development/test: allowed; FLOWOS_DEMO_PASSWORD or the documented local password.
 * - production (e.g. a staging demo): only with FLOWOS_ALLOW_DEMO_SEED=true AND an operator-chosen
 *   FLOWOS_DEMO_PASSWORD of at least 16 characters that is not the documented one, so a public
 *   environment never gets predictable credentials.
 * Returns the password, or throws with the reason.
 */
export function demoSeedPassword(env: NodeJS.ProcessEnv): { password: string; documented: boolean } {
  const chosen = env.FLOWOS_DEMO_PASSWORD;
  if (env.NODE_ENV === "production") {
    if (env.FLOWOS_ALLOW_DEMO_SEED !== "true") {
      throw new Error(
        "Refusing to seed demo data with NODE_ENV=production (set FLOWOS_ALLOW_DEMO_SEED=true for a staging demo).",
      );
    }
    if (!chosen || chosen.length < 16 || chosen === LOCAL_DEMO_PASSWORD) {
      throw new Error(
        "In production, set FLOWOS_DEMO_PASSWORD to a private password of at least 16 characters (not the documented demo password).",
      );
    }
    return { password: chosen, documented: false };
  }
  if (chosen && chosen.length < 10) throw new Error("FLOWOS_DEMO_PASSWORD must be at least 10 characters.");
  return chosen
    ? { password: chosen, documented: false }
    : { password: LOCAL_DEMO_PASSWORD, documented: true };
}
