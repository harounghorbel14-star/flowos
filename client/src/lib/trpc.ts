import { createTRPCReact, type CreateTRPCReact } from "@trpc/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import superjson from "superjson";
import type { AppRouter } from "../../../server/src/trpc/router";

export const trpc: CreateTRPCReact<AppRouter, unknown> = createTRPCReact<AppRouter>();
export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type RouterInputs = inferRouterInputs<AppRouter>;

/**
 * The active organization travels as a header. The server re-verifies
 * membership on every request; this value is a selection, not a credential.
 */
let activeOrgId: string | null = null;
export const setActiveOrgId = (id: string | null) => {
  activeOrgId = id;
};
export const getActiveOrgId = () => activeOrgId;

export function createTrpcClient() {
  return trpc.createClient({
    links: [
      httpBatchLink({
        url: "/api/trpc",
        transformer: superjson,
        headers: () => ({
          "x-flowos-client": "web",
          ...(activeOrgId ? { "x-flowos-org": activeOrgId } : {}),
        }),
      }),
    ],
  });
}

/** "startDate" → "Start date": a readable name for a server field key. */
function fieldLabel(key: string): string {
  const words = key
    .split(".")
    .pop()!
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function errorMessage(err: unknown): string {
  if (err instanceof TRPCClientError) {
    const fieldErrors = (err.data as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors;
    if (fieldErrors) {
      const first = Object.entries(fieldErrors)[0];
      if (first) return `${fieldLabel(first[0])}: ${first[1][0]}`;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}

export function errorCode(err: unknown): string | undefined {
  return err instanceof TRPCClientError ? (err.data as { code?: string } | undefined)?.code : undefined;
}

export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof TRPCClientError)) return {};
  const fe = (err.data as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors ?? {};
  return Object.fromEntries(Object.entries(fe).map(([k, v]) => [k, v[0] ?? ""]));
}

/**
 * The form-level message for a failed mutation, or null when every problem is
 * already shown next to a field in `shown`. Nothing fails silently: a field
 * error for a field the form does not render still surfaces here.
 */
export function formError(err: unknown, shown: readonly string[]): string | null {
  if (!err) return null;
  const fe = fieldErrors(err);
  const keys = Object.keys(fe);
  if (keys.length === 0) return errorMessage(err);
  const unshown = keys.find((k) => !shown.includes(k));
  return unshown ? `${fieldLabel(unshown)}: ${fe[unshown]}` : null;
}
