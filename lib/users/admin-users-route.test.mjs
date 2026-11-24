import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The admin user-management routes over a real store in a throwaway agent directory.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "ompweb-admin-routes-"));
delete process.env.OMP_WEB_PASSWORD_HASH;
delete process.env.OMP_WEB_PASSWORD;

const { pinWebAuthSecretForTests } = await import("../web-auth-secret.ts");
pinWebAuthSecretForTests({ salt: "c".repeat(43), key: "d".repeat(43) });
const { createUserSession, OMP_WEB_SESSION_COOKIE } = await import("../web-auth.ts");
const { UserStore } = await import("./store.ts");
const collection = await import("../../app/api/admin/users/route.ts");
const detail = await import("../../app/api/admin/users/[id]/route.ts");

const store = new UserStore(join(process.env.PI_CODING_AGENT_DIR, "omp-web", "users.db"));
const root = store.createUser({ username: "root", role: "admin", password: "super-secret-1", options: { logN: 12 } });
const rootCookie = `${OMP_WEB_SESSION_COOKIE}=${createUserSession(root.id, root.tokenEpoch)}`;

const asRoot = (url, init = {}) => new Request(url, { ...init, headers: { ...(init.headers ?? {}), cookie: rootCookie } });
const json = (method, body) => ({ method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const COLLECTION_URL = "http://localhost:30177/api/admin/users";

test("GET /api/admin/users lists accounts and never leaks password hashes", async () => {
  const response = await collection.GET(asRoot(COLLECTION_URL));
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /"username":"root"/);
  assert.doesNotMatch(text, /passwordHash|scrypt\$/);
});

test("POST /api/admin/users creates accounts with normalized names and default role", async () => {
  const response = await collection.POST(asRoot(COLLECTION_URL, json("POST", { username: "Zoë".normalize("NFC"), password: "secret-123" })));
  assert.equal(response.status, 400); // non-ascii usernames are rejected
  const created = await collection.POST(asRoot(COLLECTION_URL, json("POST", { username: "Zoe", password: "secret-123" })));
  assert.equal(created.status, 201);
  const { user } = await created.json();
  assert.equal(user.username, "zoe");
  assert.equal(user.role, "user");
  assert.equal(user.status, "active");

  const duplicate = await collection.POST(asRoot(COLLECTION_URL, json("POST", { username: "ZOE", password: "secret-123" })));
  assert.equal(duplicate.status, 409);
  const missingPassword = await collection.POST(asRoot(COLLECTION_URL, json("POST", { username: "nameless" })));
  assert.equal(missingPassword.status, 400);
  const badJson = await collection.POST(asRoot(COLLECTION_URL, { method: "POST", body: "not json" }));
  assert.equal(badJson.status, 400);
});

test("a plain user may not manage accounts; anonymous gets 401", async () => {
  const member = store.createUser({ username: "plain", role: "user", password: "member-pass", options: { logN: 12 } });
  const memberCookie = `${OMP_WEB_SESSION_COOKIE}=${createUserSession(member.id, member.tokenEpoch)}`;
  const forbidden = await collection.GET(new Request(COLLECTION_URL, { headers: { cookie: memberCookie } }));
  assert.equal(forbidden.status, 403);
  assert.equal((await collection.GET(new Request(COLLECTION_URL))).status, 401);
  assert.equal((await detail.GET(new Request(`${COLLECTION_URL}/${member.id}`, { headers: { cookie: memberCookie } }), { params: Promise.resolve({ id: String(member.id) }) })).status, 403);
});

test("PATCH changes role, status and password; each revokes older sessions when they must", async () => {
  const pat = store.createUser({ username: "pat", role: "user", password: "secret-123", options: { logN: 12 } });
  const context = { params: Promise.resolve({ id: String(pat.id) }) };
  const patToken = createUserSession(pat.id, pat.tokenEpoch);

  const promoted = await detail.PATCH(asRoot(`${COLLECTION_URL}/${pat.id}`, json("PATCH", { role: "admin" })), context);
  assert.equal(promoted.status, 200);
  assert.equal((await promoted.json()).user.role, "admin");

  const badField = await detail.PATCH(asRoot(`${COLLECTION_URL}/${pat.id}`, json("PATCH", { nickname: "z" })), context);
  assert.equal(badField.status, 400);
  const badRole = await detail.PATCH(asRoot(`${COLLECTION_URL}/${pat.id}`, json("PATCH", { role: "wizard" })), context);
  assert.equal(badRole.status, 400);
  const missing = await detail.PATCH(asRoot(`${COLLECTION_URL}/99999`, json("PATCH", { role: "user" })), { params: Promise.resolve({ id: "99999" }) });
  assert.equal(missing.status, 404);
  const badId = await detail.PATCH(asRoot(`${COLLECTION_URL}/not-a-number`, json("PATCH", { role: "user" })), { params: Promise.resolve({ id: "not-a-number" }) });
  assert.equal(badId.status, 400);

  const banned = await detail.PATCH(asRoot(`${COLLECTION_URL}/${pat.id}`, json("PATCH", { status: "banned" })), context);
  assert.equal(banned.status, 200);
  assert.equal((await banned.json()).user.tokenEpoch, pat.tokenEpoch + 1);
  // The session minted before the ban is dead now.
  assert.equal((await detail.GET(new Request(`${COLLECTION_URL}/${pat.id}`, { headers: { cookie: `${OMP_WEB_SESSION_COOKIE}=${patToken}` } }), context)).status, 401);

  const reset = await detail.PATCH(asRoot(`${COLLECTION_URL}/${pat.id}`, json("PATCH", { password: "brand-new-pw", status: "active" })), context);
  assert.equal(reset.status, 200);
  assert.ok(store.verifyLogin("pat", "brand-new-pw"));
  const vpn = await detail.PATCH(asRoot(`${COLLECTION_URL}/${pat.id}`, json("PATCH", { vpnProfile: "client\nremote vpn.example 1194" })), context);
  assert.equal(vpn.status, 200);
  assert.equal((await vpn.json()).user.vpnProfile, "client\nremote vpn.example 1194");
  const badVpn = await detail.PATCH(asRoot(`${COLLECTION_URL}/${pat.id}`, json("PATCH", { vpnProfile: "garbage" })), context);
  assert.equal(badVpn.status, 400);
});

test("PATCH validates every field before writing any: a bad password leaves the role untouched", async () => {
  const amy = store.createUser({ username: "amy", role: "admin", password: "secret-123", options: { logN: 12 } });
  const context = { params: Promise.resolve({ id: String(amy.id) }) };
  // "x" is too short: the role change must not be applied either (previously setRole ran first).
  const refused = await detail.PATCH(asRoot(`${COLLECTION_URL}/${amy.id}`, json("PATCH", { role: "user", password: "x" })), context);
  assert.equal(refused.status, 400);
  assert.equal(store.findUserById(amy.id)?.role, "admin", "a rejected PATCH leaves no partial write behind");
});

test("DELETE removes members but never the caller's own account", async () => {
  const doomed = store.createUser({ username: "doomed", role: "user", password: "secret-123", options: { logN: 12 } });
  const ok = await detail.DELETE(asRoot(`${COLLECTION_URL}/${doomed.id}`, { method: "DELETE" }), { params: Promise.resolve({ id: String(doomed.id) }) });
  assert.equal(ok.status, 204);
  assert.equal((await detail.GET(asRoot(`${COLLECTION_URL}/${doomed.id}`), { params: Promise.resolve({ id: String(doomed.id) }) })).status, 404);
  const selfDelete = await detail.DELETE(asRoot(`${COLLECTION_URL}/${root.id}`, { method: "DELETE" }), { params: Promise.resolve({ id: String(root.id) }) });
  assert.equal(selfDelete.status, 409);
});
