import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The visibility matrix over a real store in a throwaway agent directory, with every caller kind:
// v2 admin, v2 member, legacy v1 session, trusted proxy header and open (anonymous).
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "ompweb-access-"));
delete process.env.OMP_WEB_PASSWORD;
const { pinWebAuthSecretForTests } = await import("../web-auth-secret.ts");
pinWebAuthSecretForTests({ salt: "e".repeat(43), key: "f".repeat(43) });
const { hashPassword } = await import("../web-password-hash.ts");
// A configured hash keeps the legacy (v1) path verifiable; v2 signing mixes it in, so it is set before any cookie is minted.
process.env.OMP_WEB_PASSWORD_HASH = hashPassword("legacy-passphrase", { logN: 12 });
const TRUSTED_SECRET = "proxy-vouch-secret";
const { OMP_WEB_SESSION_COOKIE, OMP_WEB_TRUSTED_HEADER, createWebSession, createUserSession } = await import("../web-auth.ts");
process.env.OMP_WEB_TRUSTED_HEADER_SHA256 = createHash("sha256").update(TRUSTED_SECRET).digest("hex");

const { getUserStore } = await import("./store.ts");
const access = await import("./access.ts");
const { loadHosts } = await import("../hosts/registry.ts");

const store = getUserStore();
const root = store.createUser({ username: "root", role: "admin", password: "super-secret-1", options: { logN: 12 } });
const kim = store.createUser({ username: "kim", role: "user", password: "member-pass-1", options: { logN: 12 } });
const zoe = store.createUser({ username: "zoe", role: "user", password: "other-pass-1", options: { logN: 12 } });

const URL_SAMPLE = "http://localhost:30177/api/sessions";
const cookieRequest = (cookie) => new Request(URL_SAMPLE, { headers: { cookie } });
const asAdmin = cookieRequest(`${OMP_WEB_SESSION_COOKIE}=${createUserSession(root.id, root.tokenEpoch)}`);
const asKim = cookieRequest(`${OMP_WEB_SESSION_COOKIE}=${createUserSession(kim.id, kim.tokenEpoch)}`);
const asLegacy = cookieRequest(`${OMP_WEB_SESSION_COOKIE}=${createWebSession()}`);
const asTrusted = new Request(URL_SAMPLE, { headers: { [OMP_WEB_TRUSTED_HEADER]: TRUSTED_SECRET } });
const anonymous = new Request(URL_SAMPLE);
const asGarbage = cookieRequest(`${OMP_WEB_SESSION_COOKIE}=not-a-real-session`);

/** Every caller kind that sees everything regardless of ownership rows. */
const UNRESTRICTED = [["v2 admin", asAdmin], ["v1 legacy", asLegacy], ["trusted proxy", asTrusted], ["anonymous", anonymous], ["invalid cookie", asGarbage]];

test("viewerScope marks only non-admin v2 accounts as scoped", () => {
  assert.deepEqual(access.viewerScope(asKim), { scoped: true, userId: kim.id });
  for (const [name, request] of UNRESTRICTED) assert.deepEqual(access.viewerScope(request), { scoped: false }, name);
  assert.deepEqual(access.viewerScope(undefined), { scoped: false }, "handlers called without a request stay unrestricted");
});

test("canSeeSession: members see only sessions they own; unrestricted callers see every row", () => {
  store.setSessionOwner("session-kim", kim.id);
  store.setSessionOwner("session-zoe", zoe.id);
  for (const [name, request] of UNRESTRICTED) {
    assert.ok(access.canSeeSession(request, "session-kim"), name);
    assert.ok(access.canSeeSession(request, "session-zoe"), name);
    assert.ok(access.canSeeSession(request, "session-unowned"), name);
  }
  assert.ok(access.canSeeSession(asKim, "session-kim"));
  assert.ok(!access.canSeeSession(asKim, "session-zoe"), "another member's session is invisible");
  assert.ok(!access.canSeeSession(asKim, "session-unowned"), "an unowned row is invisible");
});

test("guardSession answers the shared session_not_found 404 only when the caller cannot see the session", async () => {
  const denied = access.guardSession(asKim, "session-zoe");
  assert.ok(denied, "a member's view of an unseen session is refused");
  assert.equal(denied.status, 404);
  assert.deepEqual(await denied.json(), { error: "Session not found", code: "session_not_found" });
  assert.equal(access.guardSession(asKim, "session-kim"), undefined);
  for (const [name, request] of UNRESTRICTED) assert.equal(access.guardSession(request, "session-zoe"), undefined, name);
});

test("canSeeProject: members see only projects they own, keyed like the routes do", () => {
  store.setProjectOwner("/srv/kim-app", kim.id);
  store.setProjectOwner("pool:p-1:pr-9", kim.id);
  store.setProjectOwner("/srv/zoe-app", zoe.id);
  for (const [name, request] of UNRESTRICTED) {
    assert.ok(access.canSeeProject(request, "/srv/kim-app"), name);
    assert.ok(access.canSeeProject(request, "/srv/nowhere"), name);
  }
  assert.ok(access.canSeeProject(asKim, "/srv/kim-app"));
  assert.ok(access.canSeeProject(asKim, "pool:p-1:pr-9"));
  assert.ok(!access.canSeeProject(asKim, "/srv/zoe-app"));
  assert.ok(!access.canSeeProject(asKim, "/srv/nowhere"), "unowned rows are invisible");
});

test("projectKeyFor reuses the routes' identities: pool keys verbatim, paths comparable-form", () => {
  assert.equal(access.projectKeyFor({ path: "/ignored", projectKey: "pool:p-1:pr-9" }), "pool:p-1:pr-9");
  assert.equal(access.projectKeyFor({ path: "/srv/app/" }), "/srv/app");
  assert.equal(access.projectKeyFor({ path: "C:\\Users\\X" }), "c:/users/x");
});

test("canSeeHost reads ownerUserId from hosts.json, including records predating the field", () => {
  mkdirSync(join(process.env.PI_CODING_AGENT_DIR, "omp-web"), { recursive: true });
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "omp-web", "hosts.json"), JSON.stringify({
    hosts: [
      { id: "local", label: "This machine", tokenHash: "a".repeat(64), createdAt: "2026-01-01T00:00:00.000Z", lastSeenAt: null, allowAgentStart: false, shareCredentials: false },
      { id: "host-kim", label: "Kim box", tokenHash: "b".repeat(64), createdAt: "2026-01-01T00:00:00.000Z", lastSeenAt: null, allowAgentStart: false, shareCredentials: false, ownerUserId: kim.id },
      { id: "host-zoe", label: "Zoe box", tokenHash: "c".repeat(64), createdAt: "2026-01-01T00:00:00.000Z", lastSeenAt: null, allowAgentStart: false, shareCredentials: false, ownerUserId: zoe.id },
    ],
  }));
  // Back-compat: the record without the field loads unchanged and counts as unowned.
  assert.equal(loadHosts().find((host) => host.id === "local").ownerUserId, null);
  for (const [name, request] of UNRESTRICTED) {
    assert.ok(access.canSeeHost(request, "local"), name);
    assert.ok(access.canSeeHost(request, "host-kim"), name);
    assert.ok(access.canSeeHost(request, "never-registered"), name);
  }
  assert.ok(access.canSeeHost(asKim, "host-kim"));
  assert.ok(!access.canSeeHost(asKim, "host-zoe"), "another member's host is invisible");
  assert.ok(!access.canSeeHost(asKim, "local"), "an unowned host is invisible");
  assert.ok(!access.canSeeHost(asKim, "never-registered"), "an unknown host is invisible");
});

test("claims write ownership rows only for scoped callers", () => {
  access.claimSession(asKim, "created-by-kim");
  assert.equal(store.sessionOwner("created-by-kim"), kim.id);
  access.claimSession(asAdmin, "created-by-root");
  assert.equal(store.sessionOwner("created-by-root"), null, "unrestricted callers never gain ownership rows");
  access.claimProject(asKim, "pool:p-1:cloned-by-kim");
  assert.equal(store.projectOwner("pool:p-1:cloned-by-kim"), kim.id);
  access.claimProject(asLegacy, "/srv/legacy-added");
  assert.equal(store.projectOwner("/srv/legacy-added"), null);
});

test("scopeFromOwner maps requestOwner() values onto the same visibility classes", () => {
  assert.deepEqual(access.scopeFromOwner(`user:${kim.id}`), { scoped: true, userId: kim.id });
  assert.deepEqual(access.scopeFromOwner(`user:${root.id}`), { scoped: false }, "admins are never scoped");
  assert.deepEqual(access.scopeFromOwner("user:999999"), { scoped: true, userId: 999999 }, "a token whose account was deleted stays scoped to that id (deny-all for live data)");
  assert.deepEqual(access.scopeFromOwner("session:abc123"), { scoped: false });
  assert.deepEqual(access.scopeFromOwner("trusted"), { scoped: false });
  assert.deepEqual(access.scopeFromOwner("open"), { scoped: false });
});

test("projectKeyFor namespaces path-derived keys by host", () => {
  const h1 = access.projectKeyFor({ path: "/home/omp/app", hostId: "h1" });
  const h2 = access.projectKeyFor({ path: "/home/omp/app", hostId: "h2" });
  assert.notEqual(h1, h2, "identical paths on different hosts are different projects");
  assert.equal(access.projectKeyFor({ projectKey: "pool:p:x", hostId: "h1" }), "pool:p:x", "explicit pool keys win");
});
