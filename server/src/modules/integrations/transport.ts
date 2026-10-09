/**
 * Outbound HTTPS for messaging integrations. URLs are validated against a
 * per-provider host allow-list before they are stored (shared/integrations.ts);
 * here redirects are refused too, so a webhook can never bounce the server to
 * another host.
 */
export class DeliveryError extends Error {
  constructor(
    message: string,
    /** false = retrying cannot help (e.g. the webhook was deleted). */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "DeliveryError";
  }
}

export type Transport = (url: string, body: unknown) => Promise<void>;

export const postJson: Transport = async (url, body) => {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new DeliveryError("The service could not be reached.", true);
  }
  // Drain the body so the connection can be reused; never surface it (it may echo the request).
  await res.arrayBuffer().catch(() => undefined);
  if (res.ok) return;
  if (res.status === 429 || res.status >= 500)
    throw new DeliveryError(`The service responded ${res.status}.`, true);
  throw new DeliveryError(
    res.status === 404 || res.status === 410
      ? "The webhook no longer exists. Reconnect the integration."
      : `The service rejected the message (${res.status}).`,
    false,
  );
};

let transport: Transport = postJson;
export const getTransport = () => transport;
/** Tests only. */
export function setTransportForTests(t: Transport | undefined) {
  transport = t ?? postJson;
}
