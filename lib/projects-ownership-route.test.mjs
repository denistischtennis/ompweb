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
store.setProjectOwner(comparableProjectPath(wsA), kim.id);

const { linkLocalDaemon } = await import("./hosts/link-driver.test-helper.mjs");
const hub = await import("./hosts/hub.ts");
await linkLocalDaemon({});

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
  assert.equal(store.projectOwner(access.projectKeyFor(project)), kim.id);
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
  assert.equal(store.projectOwner(access.projectKeyFor(target)), kim.id);
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
