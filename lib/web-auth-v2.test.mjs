import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Multi-user (fork) session handling in web-auth plus the gate behaviour it drives in proxy.ts.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "ompweb-v2-"));
delete process.env.OMP_WEB_PASSWORD_HASH;
delete process.env.OMP_WEB_PASSWORD;

const { pinWebAuthSecretForTests } = await import("./web-auth-secret.ts");
pinWebAuthSecretForTests({ salt: "a".repeat(43), key: "b".repeat(43) });
const { hashPassword } = await import("./web-password-hash.ts");
const { UserStore } = await import("./users/store.ts");
const {
  authenticateRequest,
  createWebSession,
  createUserSession,
  isRequestAdmin,
  isValidWebSession,
  OMP_WEB_SESSION_COOKIE,
  OMP_WEB_TRUSTED_HEADER,
  parseUserSession,
  requestOwner,
  requestUser,
} = await import("./web-auth.ts");
const { proxy } = await import("../proxy.ts");

const store = new UserStore(join(process.env.PI_CODING_AGENT_DIR, "omp-web", "users.db"));
const apiRequest = (cookie, url = "http://localhost:30177/api/sessions") =>
  new Request(url, { headers: cookie ? { cookie: `${OMP_WEB_SESSION_COOKIE}=${cookie}` } : {} });

const root = store.createUser({ username: "root", role: "admin", password: "super-secret-1", options: { logN: 12 } });

test("v2 tokens round-trip and reject tampering", () => {
  const token = createUserSession(root.id, root.tokenEpoch);
  const parsed = parseUserSession(token);
  assert.equal(parsed?.userId, root.id);
  assert.equal(parsed?.epoch, root.tokenEpoch);
  assert.ok(parsed && parsed.expiresAt > Date.now());
  // The v1 format is not a v2 token.
  assert.equal(parseUserSession(createWebSession(Date.now(), { ...process.env, OMP_WEB_PASSWORD_HASH: hashPassword("x", { logN: 12 }) })), null);
  // Changing any payload part without re-signing invalidates it.
  const [, , , expiresAt, signature] = token.split(".");
  assert.equal(parseUserSession(`v2.${root.id + 7}.${0}.${expiresAt}.${signature}`), null);
  // And it dies at its expiry.
  assert.equal(parseUserSession(token, (parsed?.expiresAt ?? 0) + 1), null);
});

test("authenticateRequest resolves the account and honors status and epoch", () => {
  const member = store.createUser({ username: "member", role: "user", password: "another-secret", options: { logN: 12 } });
  const beforeReset = createUserSession(member.id, member.tokenEpoch);
  assert.equal(authenticateRequest(apiRequest(beforeReset))?.user.username, "member");

  const reset = store.resetPassword(member.id, { password: "rotated-secret", options: { logN: 12 } });
  // The issued session carried the old epoch: revoked by the reset itself.
  assert.equal(authenticateRequest(apiRequest(beforeReset)), null);
  const afterReset = createUserSession(reset.id, reset.tokenEpoch);
  assert.equal(authenticateRequest(apiRequest(afterReset))?.user.username, "member");

  store.setStatus(member.id, "banned");
  assert.equal(authenticateRequest(apiRequest(afterReset)), null);
  // A token naming a removed account authenticates as nobody.
  store.deleteUser(member.id);
  assert.equal(authenticateRequest(apiRequest(createUserSession(member.id, 9))), null);
});

test("a legacy v1 cookie still authenticates once accounts exist", () => {
  const env = { ...process.env, OMP_WEB_PASSWORD_HASH: hashPassword("correct horse battery staple", { logN: 12 }) };
  const v1 = createWebSession(Date.now(), env);
  assert.equal(isValidWebSession(v1, Date.now(), env), true);
  assert.equal(authenticateRequest(apiRequest(v1), Date.now(), env)?.kind, "legacy");
});

test("the trusted proxy header authenticates without owning an account", () => {
  const previous = process.env.OMP_WEB_TRUSTED_HEADER_SHA256;
  process.env.OMP_WEB_TRUSTED_HEADER_SHA256 = createHash("sha256").update("proxy-secret").digest("hex");
  try {
    const request = new Request("http://localhost:30177/api/sessions", { headers: { [OMP_WEB_TRUSTED_HEADER]: "proxy-secret" } });
    assert.equal(authenticateRequest(request)?.kind, "trusted");
    assert.equal(requestOwner(request), "trusted");
  } finally {
    if (previous === undefined) delete process.env.OMP_WEB_TRUSTED_HEADER_SHA256;
    else process.env.OMP_WEB_TRUSTED_HEADER_SHA256 = previous;
  }
});

test("requestOwner names the account behind a v2 cookie", () => {
  assert.equal(requestOwner(apiRequest(createUserSession(root.id, root.tokenEpoch))), `user:${root.id}`);
  assert.equal(requestUser(apiRequest(createUserSession(root.id, root.tokenEpoch)))?.username, "root");
});

test("isRequestAdmin: v2 admins yes, v2 members no, single-owner identities yes", () => {
  const member = store.createUser({ username: "viewer", role: "user", password: "watch-only-1", options: { logN: 12 } });
  assert.equal(isRequestAdmin(apiRequest(createUserSession(root.id, root.tokenEpoch))), true);
  assert.equal(isRequestAdmin(apiRequest(createUserSession(member.id, member.tokenEpoch))), false);
  // With accounts configured, an anonymous request has no rights at all.
  assert.equal(isRequestAdmin(apiRequest(undefined)), false);
});

test("the gate lets valid sessions through and answers the rest like the original", () => {
  const valid = apiRequest(createUserSession(root.id, root.tokenEpoch), "http://localhost:30177/api/sessions");
  assert.equal(proxy(valid), "authenticated");
  const forged = apiRequest("v2.1.0.9999999999999.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "http://localhost:30177/api/sessions");
  const answer = proxy(forged);
  assert.ok(answer instanceof Response);
  assert.equal(answer.status, 401);
  assert.equal(proxy(new Request("http://localhost:30177/login")), "public");
  assert.equal(proxy(apiRequest(createUserSession(root.id, root.tokenEpoch), "http://localhost:30177/login")).status, 307);
  assert.equal(proxy(new Request("http://localhost:30177/")).status, 307);
  assert.equal(proxy(new Request("http://localhost:30177/assets/app.js")), "public");
});
