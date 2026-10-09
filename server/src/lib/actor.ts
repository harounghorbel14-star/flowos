import type { Role } from "@shared/domain";
import { hasPermission, type Permission } from "@shared/permissions";
import { forbidden } from "./errors";

/**
 * The verified identity a service acts on behalf of. Only ever constructed
 * server-side from a validated session and a database membership lookup —
 * never from client-supplied role or organization claims.
 */
export interface Actor {
  userId: string;
  orgId: string;
  role: Role;
  ip: string | null;
  /** Set when acting on behalf of a workflow: how many workflow hops deep we are. */
  workflowDepth?: number;
}

export function can(actor: Actor, permission: Permission): boolean {
  return hasPermission(actor.role, permission);
}

export function assertCan(actor: Actor, permission: Permission): void {
  if (!can(actor, permission)) throw forbidden();
}
