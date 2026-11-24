import { parseJsonWithinLimit, RequestBodyTooLargeError } from "../bounded-form-data";
import { asString, isRecord } from "../type-guards";
import { authenticateRequest, createUserSession, isWebPasswordEnabled, OMP_WEB_SESSION_COOKIE, OMP_WEB_SESSION_MAX_AGE_SECONDS } from "../web-auth";
import { requestProtocol } from "../request-security";
import { provisionUserSpace, reprovisionUserSpace, revokeOwnedHosts, startUserSpace, stopUserSpace, teardownUserSpace, userSpaceConfig } from "../provision/docker";
import {
  LastAdminError,
  UserInputError,
  UsernameTakenError,
  getUserStore,
  isRole,
  isStatus,
  resolvePassword,
  usersDatabaseExists,
  type UserAccount,
  type UserStatus,
  type UserRole,
} from "./store";

/**
 * The admin user-administration API (fork): list, create, inspect, change and delete accounts.
 * The route modules under app/api/admin/users keep to method exports only; the logic lives here.
 */

const MAX_BODY_BYTES = 8 * 1024;

/** undefined when the caller may manage accounts; otherwise the 401/403 to answer with. */
export function adminGuard(request: Request): Response | undefined {
  const identity = authenticateRequest(request);
  if (identity === null) {
    // An open server (no hash configured, no accounts yet) has nothing to be an admin of; it stays usable for setup.
    return isWebPasswordEnabled() || usersDatabaseExists()
      ? Response.json({ error: "Authentication required" }, { status: 401 })
      : undefined;
  }
  if (identity.kind === "user" && identity.user.role !== "admin") {
    return Response.json({ error: "Admin access required" }, { status: 403 });
  }
  return undefined;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | Response> {
  let parsed: unknown;
  try {
    parsed = await parseJsonWithinLimit(request, MAX_BODY_BYTES);
  } catch (error) {
    return error instanceof RequestBodyTooLargeError
      ? Response.json({ error: "Request body too large" }, { status: 413 })
      : Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  return isRecord(parsed)
    ? parsed
    : Response.json({ error: "body must be a JSON object" }, { status: 400 });
}

function storeFailure(error: unknown): Response {
  if (error instanceof UsernameTakenError || error instanceof LastAdminError) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof UserInputError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  throw error;
}

function parseUserId(raw: string): number | Response {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : Response.json({ error: "user id must be a positive integer" }, { status: 400 });
}

function findExistingUser(id: number): UserAccount | Response {
  const user = usersDatabaseExists() ? getUserStore().findUserById(id) : undefined;
  return user ?? Response.json({ error: "No such user" }, { status: 404 });
}

export async function listUsers(): Promise<Response> {
  const users = usersDatabaseExists() ? getUserStore().listUsers() : [];
  return Response.json({ users });
}

export async function createUser(request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  let user: UserAccount;
  try {
    user = getUserStore().createUser({
      username: body.username,
      role: body.role ?? "user",
      password: asString(body.password),
      passwordHash: asString(body.passwordHash),
    });
  } catch (error) {
    return storeFailure(error);
  }
  const space = userSpaceConfig();
  if (!space) return Response.json({ user }, { status: 201 });
  try {
    const { hostId } = await provisionUserSpace(user, space);
    return Response.json({ user, hostId }, { status: 201 });
  } catch (error) {
    // The account exists even though its space did not come up; say so instead of pretending success.
    const reason = error instanceof Error ? error.message : String(error);
    return Response.json({ user, error: `account created but provisioning failed: ${reason}` }, { status: 502 });
  }
}

export async function getUser(request: Request, rawId: string): Promise<Response> {
  const id = parseUserId(rawId);
  if (id instanceof Response) return id;
  const user = findExistingUser(id);
  return user instanceof Response ? user : Response.json({ user });
}

const PATCH_FIELDS: string[] = ["role", "status", "password", "passwordHash", "vpnProfile"];

export async function patchUser(request: Request, rawId: string): Promise<Response> {
  const id = parseUserId(rawId);
  if (id instanceof Response) return id;
  const caller = authenticateRequest(request);
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  const unknown = Object.keys(body).filter((key) => !PATCH_FIELDS.includes(key));
  if (unknown.length > 0) {
    return Response.json({ error: `unsupported field(s): ${unknown.join(", ")}` }, { status: 400 });
  }
  const existing = findExistingUser(id);
  if (existing instanceof Response) return existing;
  const store = getUserStore();
  // Validate every requested field before applying any of them, so a late invalid field cannot leave earlier ones written.
  let role: UserRole | undefined;
  if (body.role !== undefined) {
    if (!isRole(body.role)) return Response.json({ error: 'role must be "admin" or "user"' }, { status: 400 });
    role = body.role;
  }
  let status: UserStatus | undefined;
  if (body.status !== undefined) {
    if (!isStatus(body.status)) return Response.json({ error: 'status must be "active" or "banned"' }, { status: 400 });
    status = body.status;
  }
  let passwordHash: string | undefined;
  if (body.password !== undefined || body.passwordHash !== undefined) {
    try {
      passwordHash = resolvePassword({ password: asString(body.password), passwordHash: asString(body.passwordHash) });
    } catch (error) {
      return storeFailure(error);
    }
  }
  let vpnProfile: string | null | undefined;
  if (body.vpnProfile !== undefined) {
    if (typeof body.vpnProfile !== "string" && body.vpnProfile !== null) {
      return Response.json({ error: "vpnProfile must be a string or null" }, { status: 400 });
    }
    vpnProfile = body.vpnProfile;
  }
  try {
    let user = existing;
    if (role !== undefined) user = store.setRole(user.id, role);
    if (status !== undefined) user = store.setStatus(user.id, status);
    if (passwordHash !== undefined) user = store.resetPassword(user.id, { passwordHash });
    if (vpnProfile !== undefined) user = store.setVpnProfile(user.id, vpnProfile);
    // A v2 account rotating its own password just ended every older token: re-issue the
    // session cookie on responses carrying the updated record so the admin is not locked out.
    const selfCookie =
      passwordHash !== undefined && caller?.kind === "user" && caller.user.id === id
        ? new Bun.Cookie(OMP_WEB_SESSION_COOKIE, createUserSession(user.id, user.tokenEpoch), {
            httpOnly: true,
            secure: requestProtocol(request) === "https:",
            sameSite: "lax",
            maxAge: OMP_WEB_SESSION_MAX_AGE_SECONDS,
            path: "/",
          }).serialize()
        : undefined;
    const answer = (payload: Record<string, unknown>, status = 200) =>
      Response.json(payload, selfCookie === undefined ? { status } : { status, headers: { "set-cookie": selfCookie } });
    // Keep a provisioned docker space in sync with the account's state (phases 4+5).
    const space = userSpaceConfig();
    if (space && user.status === "banned") {
      await stopUserSpace(user.username);
    } else if (space && vpnProfile !== undefined) {
      try {
        await reprovisionUserSpace(user, space);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return answer({ user, error: `profile saved but the space could not be rebuilt: ${reason}` }, 502);
      }
    } else if (space && user.status !== existing.status) {
      const started = await startUserSpace(user.username);
      if (!started) return answer({ user, error: "account updated but its space could not be started" }, 502);
    }
    return answer({ user });
  } catch (error) {
    return storeFailure(error);
  }
}

export async function deleteUser(request: Request, rawId: string): Promise<Response> {
  const id = parseUserId(rawId);
  if (id instanceof Response) return id;
  const caller = authenticateRequest(request);
  if (caller?.kind === "user" && caller.user.id === id) {
    return Response.json({ error: "an admin cannot delete their own account" }, { status: 409 });
  }
  const existing = findExistingUser(id);
  if (existing instanceof Response) return existing;
  try {
    getUserStore().deleteUser(id);
  } catch (error) {
    return storeFailure(error);
  }
  if (userSpaceConfig()) {
    revokeOwnedHosts(id);
    await teardownUserSpace(existing.username).catch(() => undefined);
  }
  return new Response(null, { status: 204 });
}
