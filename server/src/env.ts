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

/**
 * The web server's extra production requirements. Only the server checks them:
 * release tools (migrations, seed, flags) need just the database.
 */
export function assertServerConfig() {
  if (env().NODE_ENV !== "production") return;
  const missing = REQUIRED_IN_PRODUCTION.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing required production configuration: ${missing.join(", ")}`);
}
