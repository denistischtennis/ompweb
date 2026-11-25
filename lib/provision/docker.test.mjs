import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const config = { image: "img:1", masterUrl: "http://m:30177", seedDefaults: true };
test("userSpaceConfig needs both the image and the master URL", () => {
  assert.deepEqual(provision.userSpaceConfig({ ...process.env, OMP_WEB_HOST_IMAGE: "img:1", OMP_WEB_PUBLIC_URL: "http://m:30177" }), config);
  assert.equal(provision.userSpaceConfig({ ...process.env, OMP_WEB_HOST_IMAGE: "img:1" }), null);
  assert.equal(provision.userSpaceConfig({ ...process.env, OMP_WEB_PUBLIC_URL: "http://m:30177" }), null);
  assert.equal(provision.userSpaceConfig({}), null);
  assert.deepEqual(provision.userSpaceConfig({ ...process.env, OMP_WEB_HOST_IMAGE: "img:1", OMP_WEB_PUBLIC_URL: "http://m:30177", OMP_WEB_SEED_DEFAULTS: "0" }), { ...config, seedDefaults: false });
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

const vpnConfig = { image: "img:1", masterUrl: "http://m:30177", vpnImage: "vpn:1", seedDefaults: true };

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
  const failedCalls = [];
  let rejection;
  try {
    await provision.provisionUserSpace(bob, config, async (args) => {
      failedCalls.push(args);
      // The volume comes up, the host run fails exactly like nodeDockerRunner reports it.
      if (args[0] === "run") throw new Error(`docker ${provision.commandLabel(args)}: no daemon`);
      return "ok";
    });
    assert.fail("provisioning must reject when docker fails");
  } catch (error) {
    rejection = error;
  }
  const tokenArg = failedCalls.find((args) => args.some((arg) => arg.startsWith("OMP_WEB_HOST_TOKEN=")))
    .find((arg) => arg.startsWith("OMP_WEB_HOST_TOKEN="));
  assert.match(rejection.message, /OMP_WEB_HOST_TOKEN=\*\*\*/, "the error masks the host token");
  assert.equal(rejection.message.includes(tokenArg), false, "the raw token never reaches the message");
  // The rollback is complete: registration revoked, both containers removed best-effort, staged files dropped.
  assert.equal(readHosts().some((record) => record.label === "bob"), false, "a failed provision must not leave its host registered");
  assert.ok(failedCalls.some((args) => args.join(" ") === "rm -f -v ompweb-host-bob"), "the started host container is removed");
  assert.ok(failedCalls.some((args) => args.join(" ") === "rm -f ompweb-vpn-bob"), "the vpn container is removed too, best effort");
  assert.equal(existsSync(join(provision.spaceDirectory("bob"), "host-token")), false, "a failed provision must not leave its staged token behind");
  assert.equal(existsSync(join(provision.spaceDirectory("bob"), "config.ovpn")), false, "and no stale staged vpn profile either");
});

test("commandLabel masks the host token argument and nothing else", () => {
  assert.equal(provision.commandLabel(["run", "-e", "OMP_WEB_HOST_TOKEN=abc123", "img:1"]), "run -e OMP_WEB_HOST_TOKEN=*** img:1");
  assert.equal(provision.commandLabel(["run", "-e", "OMP_WEB_HOST_URL=http://m:30177", "img:1"]), "run -e OMP_WEB_HOST_URL=http://m:30177 img:1");
  assert.equal(provision.commandLabel(["ps"]), "ps");
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
  // set→edit keeps a VPN: the old sidecar must be removed too, or the rebuilt host cannot join its netns.
  assert.ok(calls2.some((args) => args.join(" ") === ["rm", "-f", "ompweb-vpn-carol"].join(" ")), "reprovision removes the old vpn container");
});

test("stopUserSpace stops the vpn sidecar whenever a profile is staged", async () => {
  // carol (provisioned above) keeps a staged config.ovpn: banning must stop both containers.
  const calls = [];
  await provision.stopUserSpace("carol", async (args) => {
    calls.push(args);
    return "";
  });
  assert.deepEqual(calls, [["stop", "ompweb-host-carol"], ["stop", "ompweb-vpn-carol"]]);
  // Starting back up brings the sidecar up first: the host container joins its network namespace.
  const startCalls = [];
  assert.equal(await provision.startUserSpace("carol", async (args) => {
    startCalls.push(args);
    return "";
  }), true);
  assert.deepEqual(startCalls, [["start", "ompweb-vpn-carol"], ["start", "ompweb-host-carol"]]);
  // A failing sidecar start means the host cannot come up either: report false.
  assert.equal(await provision.startUserSpace("carol", async (args) => {
    if (args[1] === "ompweb-vpn-carol") throw new Error("no vpn");
    return "";
  }), false);
});

test("default seeding stages the master's skills, mcp.json, models.yml and config.yml without clobbering user files", () => {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  assert.equal(provision.stageUserSpace({ username: "erin", vpnProfile: null }, config, "TOKEN").seedPath, undefined, "an empty master ships no seed");
  mkdirSync(join(agentDir, "skills", "pdf"), { recursive: true });
  writeFileSync(join(agentDir, "skills", "pdf", "SKILL.md"), "# pdf skill");
  writeFileSync(join(agentDir, "mcp.json"), '{"mcpServers":{"ida":{"command":"ida-mcp"}}}');
  writeFileSync(join(agentDir, "models.yml"), "providers:\n  halogen:\n    baseUrl: http://llm/v1\n");
  writeFileSync(join(agentDir, "config.yml"), "modelRoles:\n  default: halogen/x\n");
  const seeded = provision.stageUserSpace({ username: "dave", vpnProfile: null }, config, "TOKEN");
  assert.ok(seeded.seedPath);
  assert.equal(readFileSync(join(seeded.seedPath, "skills", "pdf", "SKILL.md"), "utf8"), "# pdf skill");
  assert.equal(readFileSync(join(seeded.seedPath, "mcp.json"), "utf8"), '{"mcpServers":{"ida":{"command":"ida-mcp"}}}');
  assert.equal(readFileSync(join(seeded.seedPath, "models.yml"), "utf8"), "providers:\n  halogen:\n    baseUrl: http://llm/v1\n");
  assert.equal(readFileSync(join(seeded.seedPath, "config.yml"), "utf8"), "modelRoles:\n  default: halogen/x\n");
  const commands = provision.buildProvisionCommands("dave", config, "TOKEN", undefined, seeded.seedPath);
  assert.deepEqual(commands[1], ["run", "--rm", "--user", "root", "--entrypoint", "sh", "-v", `${seeded.seedPath}:/seed:ro`, "-v", "ompweb-host-dave-agent:/home/omp/.omp/agent", "img:1", "-c", "cp -rn /seed/. /home/omp/.omp/agent/ && chown -R omp:omp /home/omp/.omp/agent"]);
  // Restaging refreshes the seed copy; inside the volume `cp -rn` still refuses to overwrite what the user changed.
  writeFileSync(join(agentDir, "skills", "pdf", "SKILL.md"), "# pdf skill v2");
  assert.equal(readFileSync(join(provision.stageUserSpace({ username: "dave", vpnProfile: null }, config, "TOKEN").seedPath, "skills", "pdf", "SKILL.md"), "utf8"), "# pdf skill v2");
  // Seeding off: the master's files are ignored entirely.
  assert.equal(provision.stageUserSpace({ username: "erin", vpnProfile: null }, { ...config, seedDefaults: false }, "T").seedPath, undefined);
});

test("read-only mounts carry shared tool binaries into every space", () => {
  const withMounts = provision.userSpaceConfig({ ...process.env, OMP_WEB_HOST_IMAGE: "img:1", OMP_WEB_PUBLIC_URL: "http://m:30177", OMP_WEB_RO_MOUNTS: "/root/.local/bin/uvx, /usr/local/bin/pubmed-mcp-server,relative/ignored" });
  assert.ok(withMounts);
  assert.deepEqual(withMounts.roMounts, ["/root/.local/bin/uvx", "/usr/local/bin/pubmed-mcp-server"], "only absolute paths survive");
  const commands = provision.buildProvisionCommands("erin", withMounts, "T");
  const hostRun = commands[commands.length - 1];
  assert.ok(hostRun.includes("/root/.local/bin/uvx:/root/.local/bin/uvx:ro"), "each mount appears at the identical path");
  assert.ok(hostRun.includes("/usr/local/bin/pubmed-mcp-server:/usr/local/bin/pubmed-mcp-server:ro"));
});

test("ro mount entries may name an explicit destination path", () => {
  const cfg = { ...config, roMounts: ["/srv/tools/opt/ida-pro-9.4:/opt/ida-pro-9.4", "/root/.local"] };
  const hostRun = provision.buildProvisionCommands("erin", cfg, "T")[1];
  assert.ok(hostRun.includes("/srv/tools/opt/ida-pro-9.4:/opt/ida-pro-9.4:ro"), "src:dst mounts at dst");
  assert.ok(hostRun.includes("/root/.local:/root/.local:ro"), "bare src still mounts at itself");
});
