import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for secrets stored in the database (integration webhook URLs,
 * future OAuth tokens). The key comes from INTEGRATIONS_ENCRYPTION_KEY
 * (32 bytes, base64) and never leaves the server. `context` (e.g.
 * "<orgId>:<provider>") is bound as additional authenticated data, so a sealed
 * value copied to another row does not decrypt. Format: v1.<iv>.<tag>.<data>.
 */
function key(): Buffer | null {
  const raw = process.env.INTEGRATIONS_ENCRYPTION_KEY;
  if (!raw) return null;
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("INTEGRATIONS_ENCRYPTION_KEY must be 32 bytes, base64-encoded.");
  return k;
}

/** True when a valid key is configured; a malformed key counts as not configured (and is logged once). */
let warned = false;
export function encryptionConfigured(): boolean {
  try {
    return key() !== null;
  } catch (err) {
    if (!warned) {
      warned = true;
      console.error(`[crypto] ${(err as Error).message} Integrations are disabled.`);
    }
    return false;
  }
}

export function encryptSecret(plain: string, context: string): string {
  const k = key();
  if (!k) throw new Error("INTEGRATIONS_ENCRYPTION_KEY is not set.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(context, "utf8"));
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(
    ".",
  );
}

export function decryptSecret(sealed: string, context: string): string {
  const k = key();
  if (!k) throw new Error("INTEGRATIONS_ENCRYPTION_KEY is not set.");
  const [version, iv, tag, data] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Unrecognized secret format.");
  const tagBytes = Buffer.from(tag, "base64");
  if (tagBytes.length !== 16) throw new Error("Invalid authentication tag.");
  const decipher = createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64"), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(tagBytes);
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}
