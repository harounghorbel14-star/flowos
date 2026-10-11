import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  APP_ORIGIN: z.string().url().default("http://localhost:5173"),
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Trust X-Forwarded-For from this many proxy hops (0 = direct). */
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  /** Outgoing email (password reset links), e.g. smtps://user:pass@smtp.example.com:465. Secret. */
  SMTP_URL: z
    .string()
    .url()
    .refine((u) => /^smtps?:\/\//.test(u), "SMTP_URL must start with smtp:// or smtps://")
    .optional(),
  /** Sender address for outgoing email, e.g. "FLOWOS <no-reply@example.com>". */
  MAIL_FROM: z.string().min(3).max(200).optional(),
});

export type Env = z.infer<typeof schema>;

/** Variables that have a development default but must be set explicitly in production. */
const REQUIRED_IN_PRODUCTION = ["APP_ORIGIN"] as const;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      // Print variable names only — never values, which may be secrets.
      const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new Error(`Invalid environment configuration: ${names}`);
    }
    cached = parsed.data;
  }
  return cached;
}

export const isProduction = () => env().NODE_ENV === "production";

const ON = new Set(["true", "1", "yes", "on"]);
const OFF = new Set(["false", "0", "no", "off", ""]);

/**
 * An on/off switch such as FLOWOS_MIGRATE_ON_START. Hosting dashboards make it easy to save
 * "True", "true " or "\"true\"": case, surrounding spaces and quotes are ignored, and 1/0,
 * yes/no, on/off are accepted. Anything else is an error rather than a silent "off".
 * Switch values are not secrets, so errors may quote them.
 */
export function readSwitch(
  name: string,
  source: NodeJS.ProcessEnv = process.env,
): { enabled: boolean; raw: string | undefined } {
  const raw = source[name];
  if (raw === undefined) return { enabled: false, raw };
  const value = raw
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2")
    .trim()
    .toLowerCase();
  if (ON.has(value)) return { enabled: true, raw };
  if (OFF.has(value)) return { enabled: false, raw };
  throw new Error(
    `${name} must be true or false (1/0, yes/no and on/off also work); got ${JSON.stringify(raw.slice(0, 20))}.`,
  );
}

/** "host:port/database" for logs: never the user name or password. */
export function describeDatabase(url: string = env().DATABASE_URL): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

/**
 * The web server's extra production requirements. Only the server checks them:
 * release tools (migrations, seed, flags) need just the database.
 */
export function assertServerConfig() {
  if (env().NODE_ENV !== "production") return;
  const missing = REQUIRED_IN_PRODUCTION.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing required production configuration: ${missing.join(", ")}`);
}
