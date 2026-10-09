import type { Role } from "./domain";

/**
 * Role-based permissions. The server is the only authority: the client uses
 * this table purely to decide which controls to show.
 */
export const PERMISSIONS = [
  "org:update",
  "member:read",
  "member:manage",
  "audit:read",
  "employee:read",
  "employee:write",
  "department:write",
  "project:read",
  "project:write",
  "task:read",
  "task:create",
  "task:write_any",
  "task:write_own",
  "task:comment",
  "approval:create",
  "approval:decide",
  "approval:read_all",
  "workflow:read",
  "workflow:manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: Permission[] = ["member:read", "employee:read", "project:read", "task:read"];

const MEMBER: Permission[] = [...VIEWER, "task:create", "task:write_own", "task:comment", "approval:create"];

const MANAGER: Permission[] = [
  ...MEMBER,
  "employee:write",
  "department:write",
  "project:write",
  "task:write_any",
  "approval:decide",
  "workflow:read",
];

const ADMIN: Permission[] = [
  ...MANAGER,
  "org:update",
  "member:manage",
  "audit:read",
  "approval:read_all",
  "workflow:manage",
];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  OWNER: new Set(PERMISSIONS),
  ADMIN: new Set(ADMIN),
  MANAGER: new Set(MANAGER),
  MEMBER: new Set(MEMBER),
  VIEWER: new Set(VIEWER),
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

/** Roles ordered by authority, highest first. */
export const ROLE_RANK: Record<Role, number> = { OWNER: 5, ADMIN: 4, MANAGER: 3, MEMBER: 2, VIEWER: 1 };
