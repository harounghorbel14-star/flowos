import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";

/**
 * Outbound HTTPS for messaging integrations. Webhook URLs are validated
 * against a per-provider host allow-list before they are stored
 * (shared/integrations.ts). Here, as defence in depth against DNS
 * manipulation, the host is resolved once, every resolved address must be
 * public, and the connection is made to exactly the address that was
 * checked (no second lookup). Redirects are never followed and responses are
 * never surfaced.
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

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const)
  blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(net, prefix, "ipv6");

/** True for loopback, private, link-local (cloud metadata), CGNAT, multicast and reserved addresses. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return blocked.check(mapped[1]!, "ipv4");
    return blocked.check(address, "ipv6");
  }
  return true;
}

let allowPrivateForTests = false;
let testCa: Buffer | undefined;
/** Tests only: allow a local HTTPS server (and trust its self-signed certificate). */
export function allowPrivateAddressesForTests(allow: boolean, ca?: Buffer) {
  allowPrivateForTests = allow;
  testCa = allow ? ca : undefined;
}

type LookupFn = (
  hostname: string,
  options: object,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
) => void;

/** Resolve all addresses, refuse if any is private, then pin the connection to the first. */
const safeLookup: LookupFn = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    if (!allowPrivateForTests && addresses.some((a) => isPrivateAddress(a.address))) {
      const e: NodeJS.ErrnoException = new Error("refused private address");
      e.code = "EPRIVATE";
      return callback(e, []);
    }
    // Node asks for all addresses when it races IPv4/IPv6; hand back exactly the checked ones.
    if ((options as { all?: boolean }).all) return callback(null, addresses);
    const first = addresses[0]!;
    callback(null, first.address, first.family);
  });
};

export const postJson: Transport = (url, body) =>
  new Promise<void>((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      reject(new DeliveryError("The webhook URL is invalid.", false));
      return;
    }
    if (target.protocol !== "https:") {
      reject(new DeliveryError("Only HTTPS webhooks are supported.", false));
      return;
    }
    if (isIP(target.hostname.replace(/^\[|\]$/g, "")) && !allowPrivateForTests) {
      reject(new DeliveryError("Webhook URLs must use a host name.", false));
      return;
    }
    const payload = Buffer.from(JSON.stringify(body));
    const req = request(
      target,
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": payload.length },
        lookup: safeLookup as never,
        timeout: 10_000,
        ...(testCa ? { ca: testCa } : {}),
      },
      (res) => {
        // Drain without keeping the body: it may echo the request.
        res.resume();
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve();
          else if (status >= 300 && status < 400)
            reject(
              new DeliveryError(
                "The service tried to redirect the message; redirects are not followed.",
                false,
              ),
            );
          else if (status === 429 || status >= 500)
            reject(new DeliveryError(`The service responded ${status}.`, true));
          else
            reject(
              new DeliveryError(
                status === 404 || status === 410
                  ? "The webhook no longer exists. Reconnect the integration."
                  : `The service rejected the message (${status}).`,
                false,
              ),
            );
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPRIVATE") {
        reject(new DeliveryError("The webhook host resolves to a private address; refusing to send.", false));
      } else {
        reject(new DeliveryError("The service could not be reached.", true));
      }
    });
    req.end(payload);
  });

let transport: Transport = postJson;
export const getTransport = () => transport;
/** Tests only. */
export function setTransportForTests(t: Transport | undefined) {
  transport = t ?? postJson;
}
