import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// Phase 3 route scoping for /api/projects over a real agent directory: the registry the local daemon
// serves comes from <agent dir>/projects.json, owners from users.db (same seeding as lib/projects-route.test.mjs).
const root = mkdtempSync(join(tmpdir(), "ompweb-projects-ownership-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
delete process.env.OMP_WEB_PASSWORD;
delete process.env.OMP_WEB_PASSWORD_HASH;

const { pinWebAuthSecretForTests } = await import("./web-auth-secret.ts");
pinWebAuthSecretForTests({ salt: "3".repeat(43), key: "4".repeat(43) });
const { OMP_WEB_SESSION_COOKIE, createUserSession } = await import("./web-auth.ts");
const { getUserStore } = await import("./users/store.ts");
const access = await import("./users/access.ts");
const { comparableProjectPath } = await import("./comparable-path.ts");

const store = getUserStore();
const admin = store.createUser({ username: "root", role: "admin", password: "super-secret-1", options: { logN: 12 } });
const kim = store.createUser({ username: "kim", role: "user", password: "member-pass-1", options: { logN: 12 } });
const adminCookie = `${OMP_WEB_SESSION_COOKIE}=${createUserSession(admin.id, admin.tokenEpoch)}`;
const kimCookie = `${OMP_WEB_SESSION_COOKIE}=${createUserSession(kim.id, kim.tokenEpoch)}`;

// Two registered workspaces; only the first belongs to kim.
const wsA = realpathSync(mkdirSync(join(root, "ws-a"), { recursive: true }) && join(root, "ws-a"));
const wsB = realpathSync(mkdirSync(join(root, "ws-b"), { recursive: true }) && join(root, "ws-b"));
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "projects.json"), JSON.stringify({
  version: 1,
  projects: [
    { path: wsA, addedAt: "2026-01-01", hidden: false },
    { path: wsB, addedAt: "2026-01-01", hidden: false },
  ],
}));
store.setProjectOwner(access.projectKeyFor({ path: wsA, hostId: "local" }), kim.id);

const { linkLocalDaemon } = await import("./hosts/link-driver.test-helper.mjs");
const hub = await import("./hosts/hub.ts");
await linkLocalDaemon({});
// Members address only hosts their account owns: give kim the linked local host.
const { updateHost } = await import("./hosts/registry.ts");
updateHost("local", { ownerUserId: kim.id });

const route = await import("../app/api/projects/route.ts");

after(() => {
  hub.closeHostLink("local");
  hub.flushLinkSamples();
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

test("GET /api/projects: members list only owned projects; admins and open callers list all", async () => {
  const asKim = await route.GET(new Request("http://localhost:30177/api/projects", { headers: { cookie: kimCookie } }));
  assert.equal(asKim.status, 200);
  assert.deepEqual(((await asKim.json()).projects).map((project) => project.path), [wsA]);

  const asAdmin = await route.GET(new Request("http://localhost:30177/api/projects", { headers: { cookie: adminCookie } }));
  assert.deepEqual(((await asAdmin.json()).projects).map((project) => project.path).sort(), [wsA, wsB].sort());

  // Legacy argument-less call and anonymous requests keep seeing everything.
  assert.deepEqual(((await (await route.GET()).json()).projects).map((project) => project.path).sort(), [wsA, wsB].sort());
});

test("POST /api/projects by a member records ownership of the registered path", async () => {
  const wsC = realpathSync(mkdirSync(join(root, "ws-c"), { recursive: true }) && join(root, "ws-c"));
  const created = await route.POST(new Request("http://localhost:30177/api/projects", {
    method: "POST", headers: { "content-type": "application/json", cookie: kimCookie }, body: JSON.stringify({ cwd: wsC }),
  }));
  assert.equal(created.status, 200);
  const project = (await created.json()).project;
  assert.equal(store.projectOwner(access.projectKeyFor({ ...project, hostId: "local" })), kim.id);
  // It now shows up in the member's list.
  const listed = await route.GET(new Request("http://localhost:30177/api/projects", { headers: { cookie: kimCookie } }));
  assert.deepEqual(((await listed.json()).projects).map((entry) => entry.path).sort(), [wsA, wsC].sort());
});

test("PATCH /api/projects by a member records ownership of the updated paths", async () => {
  const patched = await route.PATCH(new Request("http://localhost:30177/api/projects", {
    method: "PATCH", headers: { "content-type": "application/json", cookie: kimCookie }, body: JSON.stringify({ cwd: wsB, alias: "Renamed" }),
  }));
  assert.equal(patched.status, 200);
  const { projects } = await patched.json();
  const target = projects.find((project) => comparableProjectPath(project.path) === comparableProjectPath(wsB));
  assert.ok(target, "the patched project is in the response");
  assert.equal(store.projectOwner(access.projectKeyFor({ ...target, hostId: "local" })), kim.id);
  assert.equal(JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, "projects.json"), "utf8")).projects.find((project) => project.path === wsB).alias, "Renamed");
});

test("pooled PATCH by bob renames his project without stealing alice's P2", async () => {
  const alice = store.createUser({ username: "alice", role: "user", password: "alice-pass-1", options: { logN: 12 } });
  const bob = store.createUser({ username: "bob", role: "user", password: "bob-pass-1", options: { logN: 12 } });
  const bobCookie = `${OMP_WEB_SESSION_COOKIE}=${createUserSession(bob.id, bob.tokenEpoch)}`;
  const poolProject = (id) => ({ id, name: id, origin: `https://git.example/${id}.git`, clonePaths: { local: `/srv/pool/${id}` }, addedAt: "2026-01-01", hidden: false });
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "omp-web", "pools.json"), JSON.stringify({ version: 1, pools: [{
    id: "p", label: "Pool", enabled: true,
    members: [{ hostId: "local", projectsRoot: "/srv/pool", provisioned: false, draining: false }],
    projects: [poolProject("pr-1"), poolProject("pr-2")],
  }]}));
  store.setProjectOwner("pool:p:pr-1", bob.id);
  store.setProjectOwner("pool:p:pr-2", alice.id);
  const patched = await route.PATCH(new Request("http://localhost:30177/api/projects", {
    method: "PATCH", headers: { "content-type": "application/json", cookie: bobCookie }, body: JSON.stringify({ poolId: "p", projectId: "pr-1", alias: "Bob's one" }),
  }));
  assert.equal(patched.status, 200);
  assert.equal(store.projectOwner("pool:p:pr-1"), bob.id);
  assert.equal(store.projectOwner("pool:p:pr-2"), alice.id, "editing P1 must not take ownership of alice's P2");
});

test("clone routes gate on project visibility: kim cannot clone or cancel alice's key, admins can", async () => {
  const cloneRoute = await import("../app/api/projects/clone/route.ts");
  // "pool:p:pr-2" became alice's in the previous test; for kim it is as absent as the route ever admits.
  const cloned = await cloneRoute.POST(new Request("http://localhost:30177/api/projects/clone", {
    method: "POST", headers: { "content-type": "application/json", cookie: kimCookie },
    body: JSON.stringify({ id: "pool:p:pr-2", parent: "/srv/pool", url: "https://git.example/pr-2.git" }),
  }), { disableIdleTimeout() {} });
  assert.equal(cloned.status, 404);
  assert.deepEqual(await cloned.json(), { error: "Registered project not found", code: "project_not_found" });

  const cancelled = await cloneRoute.DELETE(new Request("http://localhost:30177/api/projects/clone", {
    method: "DELETE", headers: { "content-type": "application/json", cookie: kimCookie },
    body: JSON.stringify({ id: "pool:p:pr-2" }),
  }));
  assert.equal(cancelled.status, 404);
  assert.deepEqual(await cancelled.json(), { error: "Registered project not found", code: "project_not_found" });

  // An admin's cancel passes the gate and reaches the daemon, which reports the job — not the project — as unknown.
  const adminCancel = await cloneRoute.DELETE(new Request("http://localhost:30177/api/projects/clone", {
    method: "DELETE", headers: { "content-type": "application/json", cookie: adminCookie },
    body: JSON.stringify({ id: "pool:p:pr-2" }),
  }));
  assert.notEqual((await adminCancel.json()).code, "project_not_found", "an admin's cancel is never the visibility 404");
});

// The pooled branches of POST and DELETE gained the same ownership gate as PATCH: a member may
// re-register or hide only their own (or unclaimed) pool projects, and the clone routes resolve
// hosts through the request, so a member acting on a host they do not own answers host_not_found.
test("pooled POST and DELETE refuse another member's project; clone routes thread the viewer into host resolution", async () => {
  const carol = store.createUser({ username: "carol", role: "user", password: "carol-pass-1", options: { logN: 12 } });
  const dana = store.createUser({ username: "dana", role: "user", password: "dana-pass-1", options: { logN: 12 } });
  const carolCookie = `${OMP_WEB_SESSION_COOKIE}=${createUserSession(carol.id, carol.tokenEpoch)}`;
  const danaCookie = `${OMP_WEB_SESSION_COOKIE}=${createUserSession(dana.id, dana.tokenEpoch)}`;
  const poolProject = (id) => ({ id, name: id, origin: `https://git.example/${id}.git`, clonePaths: { local: `/srv/pool/${id}` }, addedAt: "2026-01-01", hidden: false });
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "omp-web", "pools.json"), JSON.stringify({ version: 1, pools: [{
    id: "q", label: "Pool Q", enabled: true,
    members: [{ hostId: "local", projectsRoot: "/srv/pool", provisioned: false, draining: false }],
    projects: [poolProject("pr-1")],
  }]}));
  store.setProjectOwner("pool:q:pr-1", dana.id);
  const readPools = () => JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, "omp-web", "pools.json"), "utf8")).pools;

  // Re-registering dana's origin as carol answers like PATCH and leaves the registry untouched.
  const stolen = await route.POST(new Request("http://localhost:30177/api/projects", {
    method: "POST", headers: { "content-type": "application/json", cookie: carolCookie }, body: JSON.stringify({ poolId: "q", origin: "https://git.example/pr-1.git", name: "Stolen" }),
  }));
  assert.equal(stolen.status, 400);
  assert.deepEqual(await stolen.json(), { error: "Registered project not found", code: "project_not_found" });
  assert.deepEqual(readPools()[0].projects, [poolProject("pr-1")], "the refused registration mutates nothing");

  // Hiding dana's project as carol fails the same way; dana may hide her own.
  const refusedHide = await route.DELETE(new Request("http://localhost:30177/api/projects", {
    method: "DELETE", headers: { "content-type": "application/json", cookie: carolCookie }, body: JSON.stringify({ poolId: "q", projectId: "pr-1" }),
  }));
  assert.equal(refusedHide.status, 400);
  assert.deepEqual(await refusedHide.json(), { error: "Registered project not found", code: "project_not_found" });
  assert.equal(readPools()[0].projects[0].hidden, false);
  const ownHide = await route.DELETE(new Request("http://localhost:30177/api/projects", {
    method: "DELETE", headers: { "content-type": "application/json", cookie: danaCookie }, body: JSON.stringify({ poolId: "q", projectId: "pr-1" }),
  }));
  assert.equal(ownHide.status, 200);
  assert.equal(readPools()[0].projects[0].hidden, true);

  // A brand-new origin needs no gate: carol registers it and claims it.
  const fresh = await route.POST(new Request("http://localhost:30177/api/projects", {
    method: "POST", headers: { "content-type": "application/json", cookie: carolCookie }, body: JSON.stringify({ poolId: "q", origin: "https://git.example/pr-9.git" }),
  }));
  assert.equal(fresh.status, 200);
  const created = (await fresh.json()).project;
  assert.equal(store.projectOwner(access.projectKeyFor(created)), carol.id);

  // Carol owns pr-9 but no host here (kim holds the linked local one): an unthreaded request would
  // reach the daemon, a threaded one answers exactly like an unknown host.
  const cloneRoute = await import("../app/api/projects/clone/route.ts");
  const foreignClone = await cloneRoute.POST(new Request("http://localhost:30177/api/projects/clone", {
    method: "POST", headers: { "content-type": "application/json", cookie: carolCookie },
    body: JSON.stringify({ id: access.projectKeyFor(created), parent: "/srv/pool", url: "https://git.example/pr-9.git" }),
  }), { disableIdleTimeout() {} });
  assert.equal(foreignClone.status, 404);
  assert.equal((await foreignClone.json()).code, "host_not_found");

  const foreignCancel = await cloneRoute.DELETE(new Request("http://localhost:30177/api/projects/clone", {
    method: "DELETE", headers: { "content-type": "application/json", cookie: carolCookie },
    body: JSON.stringify({ id: access.projectKeyFor(created) }),
  }));
  assert.equal(foreignCancel.status, 404);
  assert.equal((await foreignCancel.json()).code, "host_not_found");
});
