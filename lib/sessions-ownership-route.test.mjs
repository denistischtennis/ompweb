import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// Phase 3 route scoping for /api/sessions and /api/sessions/[id] over a real agent directory:
// sessions come from a linked local daemon (lib/hosts/link-driver.test-helper.mjs), owners from users.db.
const agentDir = mkdtempSync(join(tmpdir(), "ompweb-sessions-ownership-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.OMP_WEB_PASSWORD;
delete process.env.OMP_WEB_PASSWORD_HASH;

const { pinWebAuthSecretForTests } = await import("./web-auth-secret.ts");
pinWebAuthSecretForTests({ salt: "1".repeat(43), key: "2".repeat(43) });
const { OMP_WEB_SESSION_COOKIE, createUserSession } = await import("./web-auth.ts");
const { getUserStore } = await import("./users/store.ts");
const { invalidateSessionListCache } = await import("./session-reader.ts");

const store = getUserStore();
const root = store.createUser({ username: "root", role: "admin", password: "super-secret-1", options: { logN: 12 } });
const kim = store.createUser({ username: "kim", role: "user", password: "member-pass-1", options: { logN: 12 } });
const adminCookie = `${OMP_WEB_SESSION_COOKIE}=${createUserSession(root.id, root.tokenEpoch)}`;
const kimCookie = `${OMP_WEB_SESSION_COOKIE}=${createUserSession(kim.id, kim.tokenEpoch)}`;

// Two real session files on this machine's daemon, one owned by each member.
const ID_KIM = "0a000000-0000-4000-8000-0000000000a1";
const ID_ZOE = "0a000000-0000-4000-8000-0000000000b2";
const workspace = join(agentDir, "workspace");
mkdirSync(workspace, { recursive: true });
const sessionFile = (name, id) => {
  const header = { type: "session", version: 3, id, cwd: workspace, timestamp: "2026-01-01T00:00:00.000Z" };
  const entry = { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hi" } };
  const path = join(agentDir, "sessions", "-workspace", name);
  mkdirSync(join(agentDir, "sessions", "-workspace"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`);
};
sessionFile(`${ID_KIM}.jsonl`, ID_KIM);
sessionFile(`${ID_ZOE}.jsonl`, ID_ZOE);
store.setSessionOwner(ID_KIM, kim.id);
invalidateSessionListCache();

const { linkLocalDaemon } = await import("./hosts/link-driver.test-helper.mjs");
const hub = await import("./hosts/hub.ts");
await linkLocalDaemon({});

const sessionsListRoute = await import("../app/api/sessions/route.ts");
const sessionRoute = await import("../app/api/sessions/[id]/route.ts");
const agentBashOutputRoute = await import("../app/api/agent/[id]/bash-output/route.ts");
const localFileRoute = await import("../app/api/sessions/[id]/local-file/route.ts");

after(() => {
  hub.closeHostLink("local");
  hub.flushLinkSamples();
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(agentDir, { recursive: true, force: true });
});

const as = (cookie, url) => new Request(url, cookie ? { headers: { cookie } } : {});
const listUrl = "http://localhost:30177/api/sessions";

test("GET /api/sessions: members get only their own sessions and running ids", async () => {
  const anonymousBody = await (await sessionsListRoute.GET(as(undefined, listUrl))).json();
  assert.deepEqual(anonymousBody.sessions.map((s) => s.id).sort(), [ID_KIM, ID_ZOE].sort(), "open server keeps seeing everything");

  const adminBody = await (await sessionsListRoute.GET(as(adminCookie, listUrl))).json();
  assert.deepEqual(adminBody.sessions.map((s) => s.id).sort(), [ID_KIM, ID_ZOE].sort(), "admins keep seeing everything");

  const kimResponse = sessionsListRoute.GET(as(kimCookie, listUrl));
  const kimBody = await (await kimResponse).json();
  assert.deepEqual(kimBody.sessions.map((s) => s.id), [ID_KIM]);
  assert.deepEqual(kimBody.runningSessionIds, []);
  assert.deepEqual(kimBody.runningSessions, []);

  // The ?id= branch honors scoping too.
  const hidden = await (await sessionsListRoute.GET(as(kimCookie, `${listUrl}?id=${ID_ZOE}`))).json();
  assert.deepEqual(hidden.sessions, []);
  const mine = await (await sessionsListRoute.GET(as(kimCookie, `${listUrl}?id=${ID_KIM}`))).json();
  assert.deepEqual(mine.sessions.map((s) => s.id), [ID_KIM]);

  // The ETag reflects the filtered body: it differs per viewer scope and a conditional GET short-circuits.
  const kimEtag = (await sessionsListRoute.GET(as(kimCookie, listUrl))).headers.get("etag");
  const adminEtag = (await sessionsListRoute.GET(as(adminCookie, listUrl))).headers.get("etag");
  assert.ok(kimEtag && adminEtag);
  assert.notEqual(kimEtag, adminEtag);
  const conditional = await sessionsListRoute.GET(new Request(listUrl, { headers: { cookie: kimCookie, "if-none-match": kimEtag } }));
  assert.equal(conditional.status, 304);
});

test("GET /api/sessions/[id]: 200 for the owning member, 404 for another member's session", async () => {
  const owned = await sessionRoute.GET(as(kimCookie, `http://localhost:30177/api/sessions/${ID_KIM}`), { params: Promise.resolve({ id: ID_KIM }) });
  assert.equal(owned.status, 200);
  assert.equal((await owned.json()).sessionId, ID_KIM);

  const foreign = await sessionRoute.GET(as(kimCookie, `http://localhost:30177/api/sessions/${ID_ZOE}`), { params: Promise.resolve({ id: ID_ZOE }) });
  assert.equal(foreign.status, 404);
  assert.deepEqual(await foreign.json(), { error: "Session not found", code: "session_not_found" });

  const asAdmin = await sessionRoute.GET(as(adminCookie, `http://localhost:30177/api/sessions/${ID_ZOE}`), { params: Promise.resolve({ id: ID_ZOE }) });
  assert.equal(asAdmin.status, 200);
});

test("member GET /api/agent/[id]/bash-output and /api/sessions/[id]/local-file on an unowned session: 404", async () => {
  const bash = await agentBashOutputRoute.GET(as(kimCookie, `http://localhost:30177/api/agent/${ID_ZOE}/bash-output?path=/tmp/out.log`), { params: Promise.resolve({ id: ID_ZOE }), disableIdleTimeout() {} });
  assert.equal(bash.status, 404);
  assert.deepEqual(await bash.json(), { error: "Session not found", code: "session_not_found" });

  const file = await localFileRoute.GET(as(kimCookie, `http://localhost:30177/api/sessions/${ID_ZOE}/local-file?uri=local://out.txt`), { params: Promise.resolve({ id: ID_ZOE }) });
  assert.equal(file.status, 404);
  assert.deepEqual(await file.json(), { error: "Session not found", code: "session_not_found" });

  // The owning member still gets through the same guards: any other answer, never session_not_found.
  const mine = await agentBashOutputRoute.GET(as(kimCookie, `http://localhost:30177/api/agent/${ID_KIM}/bash-output?path=/tmp/missing.log`), { params: Promise.resolve({ id: ID_KIM }), disableIdleTimeout() {} });
  assert.notEqual((await mine.json()).code, "session_not_found", "an owned session is not hidden behind the guard");
});
