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
