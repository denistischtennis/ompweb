import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { deriveSessionSigningKey, resolveWebAuthSecret } from "./web-auth-secret";
import { isPasswordHash, verifyPassword } from "./web-password-hash";
import { getUserStore, usersDatabaseExists, type UserAccount } from "./users/store";

export const OMP_WEB_SESSION_COOKIE = "omp_web_session";
export const OMP_WEB_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
// Set by a trusted reverse proxy (see README) to vouch for a request in place of a session.
export const OMP_WEB_TRUSTED_HEADER = "x-omp-web-auth";

/**
 * Password protection for the web UI (issue #239). Only a hash is accepted:
 * `OMP_WEB_PASSWORD_HASH` holds the output of `ompweb hash-password`, and the
 * plaintext is never read from the environment, so it cannot leak into the
 * `omp` child processes omp-web spawns or into anything an agent prints.
 */
export const WEB_PASSWORD_HASH_VAR = "OMP_WEB_PASSWORD_HASH";
/** Legacy plaintext variable. Still *detected*, only to refuse to start. */
export const WEB_PASSWORD_VAR = "OMP_WEB_PASSWORD";

function hash(value: string): Buffer {
  return createHmac("sha256", "omp-web-compare-v1").update(value, "utf8").digest();
}

function equal(left: string, right: string): boolean {
  return timingSafeEqual(hash(left), hash(right));
}

function configuredHash(env: NodeJS.ProcessEnv = process.env): string {
  return (env[WEB_PASSWORD_HASH_VAR] ?? "").trim();
}

/** True when a usable password hash is configured. */
export function isWebPasswordEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isPasswordHash(configuredHash(env));
}

// The proxy sends the secret itself; omp-web holds only its SHA-256 hex digest.
// The secret is random, so a fast hash suffices.
export function isTrustedProxyRequest(
  value: string | null | undefined,
  digest = process.env.OMP_WEB_TRUSTED_HEADER_SHA256,
): boolean {
  if (!value || !digest || !/^[0-9a-f]{64}$/i.test(digest)) return false;
  return timingSafeEqual(createHash("sha256").update(value, "utf8").digest(), Buffer.from(digest, "hex"));
}

/** The web session a request belongs to (browser link spec B5): browser-link resumes and composer uploads are honored
 * only for the same one. Multi-user sessions (`v2`, fork) name their account; the gate (proxy.ts) validated the
 * signature before any handler sees the request, so this reads the shape only. */
export function requestOwner(request: Request): string {
  const cookie = new Bun.CookieMap(request.headers.get("cookie") ?? "").get(OMP_WEB_SESSION_COOKIE);
  if (cookie) {
    const userId = /^v2\.(\d+)\./.exec(cookie)?.[1];
    if (userId !== undefined) return `user:${userId}`;
    return `session:${createHash("sha256").update(cookie).digest("base64url")}`;
  }
  return isTrustedProxyRequest(request.headers.get(OMP_WEB_TRUSTED_HEADER)) ? "trusted" : "open";
}

/** Check a sign-in attempt against the configured hash. */
export function isValidWebPassword(candidate: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const stored = configuredHash(env);
  return isPasswordHash(stored) && verifyPassword(candidate, stored);
}

/**
 * Why password protection is unusable, or null when the configuration is fine.
 * Distinguishes "nothing configured" (open server, allowed on loopback) from
 * "configured but wrong" (must not silently run unprotected).
 */
export function webPasswordConfigurationProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env[WEB_PASSWORD_HASH_VAR] ?? "").trim();
  const legacy = env[WEB_PASSWORD_VAR];
  const hasLegacy = typeof legacy === "string" && legacy.length > 0;
  if (raw && hasLegacy) {
    return `Both ${WEB_PASSWORD_HASH_VAR} and the plaintext ${WEB_PASSWORD_VAR} are set. Remove ${WEB_PASSWORD_VAR}: omp-web no longer reads a plaintext password.`;
  }
  if (!raw) {
    if (!hasLegacy) return null;
    return [
      `Plaintext passwords are no longer accepted: omp-web refuses to start with ${WEB_PASSWORD_VAR} set.`,
      "",
      "Create a hash and use that instead:",
      "",
      "  ompweb hash-password",
      `  OMP_WEB_PASSWORD_HASH='scrypt$...' ompweb`,
      "",
      `See the README for the service installers, which hash the password for you.`,
    ].join("\n");
  }
  if (!isPasswordHash(raw)) {
    return [
      `${WEB_PASSWORD_HASH_VAR} is not a valid password hash.`,
      "",
      "Generate one with:",
      "",
      "  ompweb hash-password",
      "",
      `The value must look like scrypt$<ln>$<r>$<p>$<salt>$<digest> (unquoted, single line).`,
    ].join("\n");
  }
  return null;
}

/** Human-readable failure for a broken configuration, or null when it is usable. */
export function webPasswordConfigurationError(env: NodeJS.ProcessEnv = process.env): Error | null {
  const problem = webPasswordConfigurationProblem(env);
  return problem ? new Error(problem) : null;
}

function signingKey(env: NodeJS.ProcessEnv = process.env): string {
  const stored = configuredHash(env);
  if (!isPasswordHash(stored)) throw new Error("Password protection is not configured");
  return deriveSessionSigningKey(stored);
}

/** Sign a session cookie. The key mixes the stored hash with a per-install random secret. */
export function createWebSession(now = Date.now(), env: NodeJS.ProcessEnv = process.env): string {
  const expiresAt = now + OMP_WEB_SESSION_MAX_AGE_SECONDS * 1000;
  const payload = `v1.${expiresAt}.${randomBytes(16).toString("base64url")}`;
  const signature = createHmac("sha256", signingKey(env)).update(payload, "utf8").digest("base64url");
  return `${payload}.${signature}`;
}

export function isValidWebSession(session: string | undefined, now = Date.now(), env: NodeJS.ProcessEnv = process.env): boolean {
  if (!session) return false;
  const match = /^v1\.(\d{13})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(session);
  if (!match) return false;

  const expiresAt = Number(match[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  let expected: string;
  try {
    const payload = session.slice(0, session.lastIndexOf("."));
    expected = createHmac("sha256", signingKey(env)).update(payload, "utf8").digest("base64url");
  } catch {
    return false;
  }
  return equal(match[3], expected);
}

/* ── Multi-user sessions (fork: isolated spaces) ──────────────────────────── */

/**
 * Signing key for v2 (account-bound) sessions. Derived from the installation secret alone, so multi-user servers
 * need no `OMP_WEB_PASSWORD_HASH`; when a hash is configured it is mixed in and rotating it invalidates these too.
 */
export function userSessionSigningKey(env: NodeJS.ProcessEnv = process.env): string {
  const secret = resolveWebAuthSecret();
  const stored = (env[WEB_PASSWORD_HASH_VAR] ?? "").trim();
  return createHmac("sha256", Buffer.from(secret.key, "base64url"))
    .update(`omp-web-session-v2\0${secret.salt}\0${isPasswordHash(stored) ? stored : ""}`, "utf8")
    .digest("base64url");
}

export interface UserSessionToken {
  userId: number;
  epoch: number;
  expiresAt: number;
}

/** Parse and cryptographically verify a v2 cookie value; null unless it is a live, correctly signed token. */
export function parseUserSession(session: string | undefined, now = Date.now(), env: NodeJS.ProcessEnv = process.env): UserSessionToken | null {
  if (!session) return null;
  const match = /^v2\.(\d+)\.(\d+)\.(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(session);
  if (!match) return null;
  const userId = Number(match[1]);
  const epoch = Number(match[2]);
  const expiresAt = Number(match[3]);
  if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(epoch) || !Number.isSafeInteger(expiresAt) || expiresAt <= now) return null;
  const expected = createHmac("sha256", userSessionSigningKey(env)).update(session.slice(0, session.lastIndexOf(".")), "utf8").digest("base64url");
  return equal(match[4], expected) ? { userId, epoch, expiresAt } : null;
}

/** Sign a v2 session cookie for an account at its current token epoch. */
export function createUserSession(userId: number, epoch: number, now = Date.now(), env: NodeJS.ProcessEnv = process.env): string {
  const payload = `v2.${userId}.${epoch}.${now + OMP_WEB_SESSION_MAX_AGE_SECONDS * 1000}`;
  return `${payload}.${createHmac("sha256", userSessionSigningKey(env)).update(payload, "utf8").digest("base64url")}`;
}

/** Who a request carries: a multi-user account, a legacy password session, or a trusted-proxy pass-through. */
export type WebIdentity = { kind: "user"; user: UserAccount } | { kind: "legacy" } | { kind: "trusted" };

/** Resolve the identity behind a request, or null. A v2 token must match a live active account at its current
 * epoch, so a ban or a password reset revokes every issued session instantly. */
export function authenticateRequest(request: Request, now = Date.now(), env: NodeJS.ProcessEnv = process.env): WebIdentity | null {
  const cookie = new Bun.CookieMap(request.headers.get("cookie") ?? "").get(OMP_WEB_SESSION_COOKIE);
  if (cookie) {
    if (cookie.startsWith("v2.")) {
      const token = parseUserSession(cookie, now, env);
      if (!token || !usersDatabaseExists()) return null;
      const user = getUserStore().findUserById(token.userId);
      return user && user.status === "active" && user.tokenEpoch === token.epoch ? { kind: "user", user } : null;
    }
    return isValidWebSession(cookie, now, env) ? { kind: "legacy" } : null;
  }
  return isTrustedProxyRequest(request.headers.get(OMP_WEB_TRUSTED_HEADER), env.OMP_WEB_TRUSTED_HEADER_SHA256) ? { kind: "trusted" } : null;
}

/** The account behind a v2 request, or null (legacy, trusted or anonymous). */
export function requestUser(request: Request, now = Date.now(), env: NodeJS.ProcessEnv = process.env): UserAccount | null {
  const identity = authenticateRequest(request, now, env);
  return identity?.kind === "user" ? identity.user : null;
}

/** Admin rights: v2 admins, plus every non-account identity (legacy password, trusted header, open server) —
 * those are the original single-owner world where one credential owned everything. */
export function isRequestAdmin(request: Request, now = Date.now(), env: NodeJS.ProcessEnv = process.env): boolean {
  const identity = authenticateRequest(request, now, env);
  if (identity === null) return !isWebPasswordEnabled(env) && !usersDatabaseExists();
  return identity.kind === "user" ? identity.user.role === "admin" : true;
}
