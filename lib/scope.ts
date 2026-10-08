import { AsyncLocalStorage } from "node:async_hooks";

export type Role = "owner" | "editor" | "viewer";

/** The signed-in account a request (and any work it starts, such as a background job) acts as. */
export interface AccessScope {
  accountKey: string;
  username: string;
  role: Role;
  /** The folder (relative to FILEDUDE_ROOT) the account is confined to; "" is the whole root. */
  root: string;
}

const storage = new AsyncLocalStorage<AccessScope>();

export function currentScope() {
  return storage.getStore();
}

export function scopeRoot() {
  return storage.getStore()?.root ?? "";
}

export function runInScope<T>(scope: AccessScope, run: () => T): T {
  return storage.run(scope, run);
}

/** True when the relative path is the scope root or inside it. */
export function withinScope(relativePath: string, root = scopeRoot()) {
  return !root || relativePath === root || relativePath.startsWith(`${root}/`);
}
