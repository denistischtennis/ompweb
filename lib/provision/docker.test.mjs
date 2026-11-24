import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The docker provisioner over a fake runner and a throwaway agent dir; no daemon needed.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "ompweb-provision-"));
delete process.env.OMP_WEB_PASSWORD_HASH;
delete process.env.OMP_WEB_PASSWORD;

const { pinWebAuthSecretForTests } = await import("../web-auth-secret.ts");
pinWebAuthSecretForTests({ salt: "e".repeat(43), key: "f".repeat(43) });
const { UserStore } = await import("../users/store.ts");
const { readHosts } = await import("../hosts/registry.ts");
const provision = await import("./docker.ts");

const store = new UserStore(join(process.env.PI_CODING_AGENT_DIR, "omp-web", "users.db"));
const alice = store.createUser({ username: "alice", role: "user", password: "secret-123", options: { logN: 12 } });
const config = { image: "img:1", masterUrl: "http://m:30177" };
test("userSpaceConfig needs both the image and the master URL", () => {
  assert.deepEqual(provision.userSpaceConfig({ ...process.env, OMP_WEB_HOST_IMAGE: "img:1", OMP_WEB_PUBLIC_URL: "http://m:30177" }), config);
  assert.equal(provision.userSpaceConfig({ ...process.env, OMP_WEB_HOST_IMAGE: "img:1" }), null);
  assert.equal(provision.userSpaceConfig({ ...process.env, OMP_WEB_PUBLIC_URL: "http://m:30177" }), null);
  assert.equal(provision.userSpaceConfig({}), null);
});

test("buildProvisionCommands pins the volume, the link env pair and the image", () => {
  const commands = provision.buildProvisionCommands("alice", config, "TOKEN");
  assert.deepEqual(commands[0], ["volume", "create", "ompweb-host-alice-agent"]);
  assert.deepEqual(commands[1], [
    "run", "-d",
    "--name", "ompweb-host-alice",
    "--restart", "unless-stopped",
    "-v", "ompweb-host-alice-agent:/home/omp/.omp/agent",
    "-e", "OMP_WEB_HOST_URL=http://m:30177",
    "-e", "OMP_WEB_HOST_TOKEN=TOKEN",
    "img:1",
  ]);
});

test("provisionUserSpace registers an owned host and runs docker; a failure revokes the registration", async () => {
  const calls = [];
  const { hostId } = await provision.provisionUserSpace(alice, config, async (args) => {
    calls.push(args);
    return "ok";
  });
  const host = readHosts().find((record) => record.id === hostId);
  assert.ok(host, "the host record must exist after provisioning");
  assert.equal(host.ownerUserId, alice.id);
  assert.deepEqual(calls.map((args) => args[0]), ["volume", "run"]);

  const bob = store.createUser({ username: "bob", role: "user", password: "secret-456", options: { logN: 12 } });
  await assert.rejects(() => provision.provisionUserSpace(bob, config, async () => {
    throw new Error("no daemon");
  }), /no daemon/);
  assert.equal(readHosts().some((record) => record.label === "bob"), false, "a failed provision must not leave its host registered");
});

test("stop tolerates a missing container, start reports whether one existed, teardown removes both", async () => {
  const calls = [];
  const runner = async (args) => {
    calls.push(args);
    if (args[0] === "start") throw new Error("No such container");
    return "";
  };
  await provision.stopUserSpace("alice", runner);
  assert.equal(await provision.startUserSpace("alice", runner), false);
  assert.equal(await provision.startUserSpace("bob", async () => "started"), true);
  await provision.teardownUserSpace("bob", runner);
  assert.deepEqual(calls, [["stop", "ompweb-host-alice"], ["start", "ompweb-host-alice"], ["rm", "-f", "-v", "ompweb-host-bob"], ["volume", "rm", "ompweb-host-bob-agent"]]);
});

test("revokeOwnedHosts removes exactly the hosts owned by one account", () => {
  const expected = readHosts().filter((record) => record.ownerUserId === alice.id).map((record) => record.id);
  const revoked = provision.revokeOwnedHosts(alice.id);
  assert.deepEqual(revoked, expected);
});
