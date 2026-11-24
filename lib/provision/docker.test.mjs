import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
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

const vpnConfig = { image: "img:1", masterUrl: "http://m:30177", vpnImage: "vpn:1" };

test("userSpaceConfig carries the optional VPN image", () => {
  assert.deepEqual(provision.userSpaceConfig({ ...process.env, OMP_WEB_HOST_IMAGE: "img:1", OMP_WEB_PUBLIC_URL: "http://m:30177", OMP_WEB_VPN_IMAGE: "vpn:1" }), vpnConfig);
});

test("a staged VPN profile attaches the sidecar and shares its network namespace", () => {
  const commands = provision.buildProvisionCommands("alice", vpnConfig, "TOKEN", "/agent/omp-web/spaces/alice/config.ovpn");
  assert.equal(commands.length, 3);
  assert.deepEqual(commands[1], ["run", "-d", "--name", "ompweb-vpn-alice", "--restart", "unless-stopped", "--cap-add", "NET_ADMIN", "-v", "/agent/omp-web/spaces/alice/config.ovpn:/etc/openvpn/config.ovpn:ro", "vpn:1"]);
  assert.ok(commands[2].includes("--network"), "the host container must join the VPN container's network namespace");
  assert.ok(commands[2].includes("container:ompweb-vpn-alice"));
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

test("provisioning with a VPN stages the profile and reprovision reuses the recorded token", async () => {
  const carol = store.createUser({ username: "carol", role: "user", password: "secret-789", options: { logN: 12 } });
  const withVpn = store.setVpnProfile(carol.id, "client\nremote vpn.example 1194");
  const calls = [];
  await provision.provisionUserSpace(withVpn, vpnConfig, async (args) => {
    calls.push(args);
    return "x";
  });
  assert.equal(calls.length, 3, "volume, vpn sidecar and host");
  const dir = provision.spaceDirectory("carol");
  const token = readFileSync(join(dir, "host-token"), "utf8").trim();
  assert.ok(token.length >= 43);
  assert.equal(readFileSync(join(dir, "config.ovpn"), "utf8"), "client\nremote vpn.example 1194");
  const calls2 = [];
  await provision.reprovisionUserSpace(withVpn, vpnConfig, async (args) => {
    calls2.push(args);
    return "";
  });
  assert.deepEqual(calls2[0], ["rm", "-f", "-v", "ompweb-host-carol"]);
  assert.ok(calls2.some((args) => args.includes(`OMP_WEB_HOST_TOKEN=${token}`)), "reprovision reuses the recorded host token");
});
