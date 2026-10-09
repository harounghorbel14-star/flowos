import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  APP_ORIGIN: z.string().url().default("http://localhost:5173"),
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Trust X-Forwarded-For from this many proxy hops (0 = direct). */
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
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
    if (parsed.data.NODE_ENV === "production") {
      const missing = REQUIRED_IN_PRODUCTION.filter((name) => !process.env[name]);
      if (missing.length) throw new Error(`Missing required production configuration: ${missing.join(", ")}`);
    }
    cached = parsed.data;
  }
  return cached;
}

export const isProduction = () => env().NODE_ENV === "production";
