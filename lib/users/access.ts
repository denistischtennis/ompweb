import { comparableProjectPath } from "../comparable-path";
import { loadHosts } from "../hosts/registry";
import { requestUser } from "../web-auth";
import { getUserStore, usersDatabaseExists } from "./store";

/**
 * Phase 3 ownership scoping. A caller is *scoped* exactly when the request carries
 * a v2 account that is not an admin (lib/web-auth.ts `requestUser`): members see only
 * the sessions, projects and hosts owned by their account. Every other caller —
 * v2 admins, legacy v1 password sessions, trusted-proxy requests and open servers —
 * sees everything, exactly as before multi-user accounts existed.
 */

export interface ViewerScope {
  scoped: boolean;
  /** The member account's id; present iff `scoped`. */
  userId?: number;
}

/** The scope an owner string (lib/web-auth.ts `requestOwner`) names: only `user:<id>` member accounts restrict a caller; admins and every non-v2 owner see everything. */
export function scopeFromOwner(owner: string): ViewerScope {
  const match = /^user:(\d+)$/.exec(owner);
  if (!match || !usersDatabaseExists()) return { scoped: false };
  const user = getUserStore().findUserById(Number(match[1]));
  return user && user.role === "user" ? { scoped: true, userId: user.id } : { scoped: false };
}

/** The visibility class of a request; `undefined` requests (handlers called without one) are unrestricted. */
export function viewerScope(request: Request | undefined): ViewerScope {
  const user = request === undefined ? null : requestUser(request);
  return user === null || user.role === "admin" ? { scoped: false } : { scoped: true, userId: user.id };
}

/** True iff `request` may see the session owned per the users database. Unowned rows are invisible to members. */
export function canSeeSession(request: Request | undefined, sessionId: string): boolean {
  const scope = viewerScope(request);
  return !scope.scoped || getUserStore().sessionOwner(sessionId) === scope.userId;
}

/** True iff `request` may see the project keyed by `projectKeyFor`'s identity. Unowned rows are invisible to members. */
export function canSeeProject(request: Request | undefined, projectKey: string): boolean {
  const scope = viewerScope(request);
  return !scope.scoped || getUserStore().projectOwner(projectKey) === scope.userId;
}

/** True iff `request` may see a host whose registry record carries `ownerUserId`. Hosts without an owner are invisible to members. */
export function canSeeHost(request: Request | undefined, hostId: string): boolean {
  const scope = viewerScope(request);
  if (!scope.scoped) return true;
  return loadHosts().find((host) => host.id === hostId)?.ownerUserId === scope.userId;
}

/** The shared 404 body for sessions a caller cannot address (same shape as lib/api-utils.ts SESSION_NOT_FOUND). */
export function sessionNotFoundResponse(): Response {
  return Response.json({ error: "Session not found", code: "session_not_found" }, { status: 404 });
}

/** The 404 when a scoped caller asks for a session they do not own; undefined for everyone else. */
export function guardSession(request: Request | undefined, sessionId: string): Response | undefined {
  const scope = viewerScope(request);
  if (!scope.scoped) return undefined;
  return getUserStore().sessionOwner(sessionId) === scope.userId ? undefined : sessionNotFoundResponse();
}

/** The identity the project routes use for a project: its logical pool key, else its comparable path. */
export function projectKeyFor(project: { path?: string; projectKey?: string }): string {
  return project.projectKey ?? comparableProjectPath(project.path ?? "");
}

/** Record `request`'s account as the session's owner; no-op for unrestricted callers (they never gain rows). */
export function claimSession(request: Request | undefined, sessionId: string): void {
  const scope = viewerScope(request);
  if (scope.scoped && scope.userId !== undefined) getUserStore().setSessionOwner(sessionId, scope.userId);
}

/** Record `request`'s account as the project's owner; no-op for unrestricted callers. */
export function claimProject(request: Request | undefined, projectKey: string): void {
  const scope = viewerScope(request);
  if (scope.scoped && scope.userId !== undefined) getUserStore().setProjectOwner(projectKey, scope.userId);
}
