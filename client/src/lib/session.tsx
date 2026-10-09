import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { Role } from "@shared/domain";
import { hasPermission, type Permission } from "@shared/permissions";
import { setActiveOrgId, trpc, type RouterOutputs } from "./trpc";

type Me = NonNullable<RouterOutputs["auth"]["me"]>;
export type OrgSummary = Me["organizations"][number];

interface SessionValue {
  user: Me["user"];
  organizations: OrgSummary[];
  org: OrgSummary | null;
  switchOrg(id: string): void;
  can(permission: Permission): boolean;
}

const SessionContext = createContext<SessionValue | null>(null);
const STORAGE_KEY = "flowos.activeOrg";

function readStoredOrg(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
function storeOrg(id: string) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* storage unavailable — selection lasts for this tab only */
  }
}

export function SessionProvider({ me, children }: { me: Me; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(readStoredOrg);
  const org = me.organizations.find((o) => o.id === selected) ?? me.organizations[0] ?? null;
  // Set synchronously so the very first org-scoped request carries the header.
  setActiveOrgId(org?.id ?? null);

  const switchOrg = useCallback(
    (id: string) => {
      storeOrg(id);
      setActiveOrgId(id);
      setSelected(id);
      // Drop every cached org-scoped query so no data from the previous tenant is shown.
      queryClient.removeQueries({ predicate: (q) => JSON.stringify(q.queryKey[0]) !== '["auth","me"]' });
    },
    [queryClient],
  );

  const value = useMemo<SessionValue>(
    () => ({
      user: me.user,
      organizations: me.organizations,
      org,
      switchOrg,
      can: (permission) => (org ? hasPermission(org.role as Role, permission) : false),
    }),
    [me, org, switchOrg],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}

/** Org-scoped session; only valid inside the app shell where an org is guaranteed. */
export function useOrg() {
  const session = useSession();
  if (!session.org) throw new Error("No active organization");
  return { ...session, org: session.org };
}

export function useMe() {
  return trpc.auth.me.useQuery(undefined, { staleTime: 60_000 });
}
