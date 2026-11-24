import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { requestProtocol } from "@/lib/request-security";
import {
  createWebSession,
  createUserSession,
  isValidWebPassword,
  isWebPasswordEnabled,
  OMP_WEB_SESSION_COOKIE,
  OMP_WEB_SESSION_MAX_AGE_SECONDS,
} from "@/lib/web-auth";
import { getUserStore, isMultiUserMode } from "@/lib/users/store";

const MAX_PASSWORD_REQUEST_BYTES = 8 * 1024;

function sessionCookie(request: Request, value: string, maxAge = OMP_WEB_SESSION_MAX_AGE_SECONDS): string {
  return new Bun.Cookie(OMP_WEB_SESSION_COOKIE, value, {
    httpOnly: true,
    secure: requestProtocol(request) === "https:",
    sameSite: "lax",
    maxAge,
    path: "/",
  }).serialize();
}

/** Sign in: with an account name in multi-user mode (fork), or with the bare password in the single-password world. */
export async function POST(request: Request): Promise<Response> {
  const multiUser = isMultiUserMode();
  if (!multiUser && !isWebPasswordEnabled()) {
    return Response.json({ error: "Password protection is disabled" }, { status: 404 });
  }

  let body: { username?: unknown; password?: unknown };
  try {
    body = await parseJsonWithinLimit<{ username?: unknown; password?: unknown }>(request, MAX_PASSWORD_REQUEST_BYTES);
  } catch (error) {
    const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
    return Response.json({ error: "Invalid password request" }, { status });
  }
  const password = typeof body.password === "string" ? body.password : undefined;

  // Multi-user sign-in: the named account decides; its current epoch rides along in the token.
  if (multiUser && typeof body.username === "string" && body.username.trim() !== "") {
    const user = password === undefined ? null : getUserStore().verifyLogin(body.username, password);
    if (!user) {
      return Response.json({ error: "Incorrect username or password" }, { status: 401 });
    }
    return Response.json(
      { ok: true, user },
      { headers: { "set-cookie": sessionCookie(request, createUserSession(user.id, user.tokenEpoch)) } },
    );
  }

  // Single-password world (the upgrade path for existing deployments): a v1 session against the configured hash.
  if (isWebPasswordEnabled() && password !== undefined && isValidWebPassword(password)) {
    return Response.json({ ok: true }, { headers: { "set-cookie": sessionCookie(request, createWebSession()) } });
  }
  if (multiUser) {
    return Response.json({ error: "username is required" }, { status: 400 });
  }
  return Response.json({ error: "Incorrect password" }, { status: 401 });
}

/** Sign out: drop the session cookie; the token itself stays verifiable until it expires. */
export async function DELETE(request: Request): Promise<Response> {
  return Response.json({ ok: true }, { headers: { "set-cookie": sessionCookie(request, "", 0) } });
}
