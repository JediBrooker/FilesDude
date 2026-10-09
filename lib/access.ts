import { requireSession, type Session } from "./auth";
import { AppError } from "./http";
import { runInScope, type Role } from "./scope";
import { startTrashRetention } from "./trash-retention";

export type Permission = "read" | "write" | "owner";

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };
const PERMISSION_RANK: Record<Permission, number> = { read: 0, write: 1, owner: 2 };

export function hasPermission(role: Role, permission: Permission) {
  return ROLE_RANK[role] >= PERMISSION_RANK[permission];
}

export function assertPermission(session: Pick<Session, "role">, permission: Permission) {
  if (hasPermission(session.role, permission)) return;
  throw new AppError(permission === "owner" ? "Only the owner account can do that" : "Your account can only view files", 403, "FORBIDDEN");
}

/**
 * The one way an API route authenticates: it checks the session and the permission, then runs the
 * handler as that account, so every path the handler (and any background work it starts) resolves
 * is confined to the account's folder.
 */
export async function withAccess<T>(request: Request, permission: Permission, run: (session: Session) => Promise<T>): Promise<T> {
  const session = await requireSession(request);
  // Background upkeep starts with the first signed-in request, in the same module instance as the
  // routes (so it shares their filesystem lock).
  startTrashRetention();
  assertPermission(session, permission);
  return runInScope({ accountKey: session.accountKey, username: session.username, role: session.role, root: session.root }, () => run(session));
}
