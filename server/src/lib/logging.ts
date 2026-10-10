/**
 * A log-safe description of an error. Database errors are reduced to their
 * SQLSTATE and the table/constraint involved: drizzle's message embeds the SQL
 * and every bound parameter (password hashes, emails, names), so it is never
 * logged. Other errors keep their message and stack, which are needed to fix
 * bugs and do not contain request data.
 */
export function logSafeError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let i = 0; i < 5 && current; i++) {
    if (typeof current !== "object") {
      parts.push(String(current));
      break;
    }
    const e = current as {
      name?: string;
      message?: string;
      stack?: string;
      code?: unknown;
      table?: string;
      constraint?: string;
      cause?: unknown;
    };
    const isDbError =
      typeof e.code === "string" &&
      /^[0-9A-Z]{5}$/.test(e.code) &&
      (e.table !== undefined || "severity" in e);
    if (e.name === "DrizzleQueryError" || (e.message ?? "").startsWith("Failed query:")) {
      parts.push("database query failed");
    } else if (isDbError) {
      const where = [e.table && `table ${e.table}`, e.constraint && `constraint ${e.constraint}`]
        .filter(Boolean)
        .join(", ");
      parts.push(`database error ${String(e.code)}${where ? ` (${where})` : ""}`);
    } else {
      parts.push(e.stack ?? `${e.name ?? "Error"}: ${e.message ?? ""}`);
    }
    current = e.cause;
  }
  return parts.join("\n  caused by: ");
}
