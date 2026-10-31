import { ForbiddenError } from "../errors.js";

export type Role = "owner" | "admin" | "agent";
export const ROLES: readonly Role[] = ["owner", "admin", "agent"];

export type Permission =
  | "documents:read"
  | "documents:write"
  | "documents:delete"
  | "jobs:read"
  | "jobs:retry"
  | "search:run"
  | "conversations:read"
  | "tickets:read"
  | "tickets:write"
  | "escalations:read"
  | "escalations:handle"
  | "analytics:read"
  | "audit:read"
  | "settings:read"
  | "settings:write"
  | "keys:read"
  | "keys:write"
  | "roles:change";

const AGENT: readonly Permission[] = [
  "documents:read",
  "jobs:read",
  "search:run",
  "conversations:read",
  "tickets:read",
  "tickets:write",
  "escalations:read",
  "escalations:handle",
];
const ADMIN: readonly Permission[] = [
  ...AGENT,
  "documents:write",
  "documents:delete",
  "jobs:retry",
  "analytics:read",
  "audit:read",
  "settings:read",
  "settings:write",
  "keys:read",
];
const OWNER: readonly Permission[] = [...ADMIN, "keys:write", "roles:change"];

const MATRIX: Record<Role, ReadonlySet<Permission>> = {
  agent: new Set(AGENT),
  admin: new Set(ADMIN),
  owner: new Set(OWNER),
};

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[role].has(permission);
}

/** The authenticated caller. `tenantId` always comes from the API key, never from request input. */
export interface Actor {
  readonly tenantId: string;
  readonly keyId: string;
  readonly role: Role;
}

export function assertCan(actor: Actor, permission: Permission): void {
  if (!can(actor.role, permission)) throw new ForbiddenError();
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}
