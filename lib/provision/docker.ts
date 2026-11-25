import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHost, readHosts, revokeHost, updateHost } from "../hosts/registry";
import { getAgentDir } from "../omp/paths";
import { asString } from "../type-guards";
import type { UserAccount } from "../users/store";

/**
 * Docker provisioning of per-user host spaces (fork phase 4).
 *
 * One `deploy/Dockerfile.host` image serves every user: the app and the pinned
 * ompweb-omp binary live in the image, and each user's whole mutable state is a
 * named volume mounted at /home/omp/.omp/agent. Updating means rebuilding/pulling
 * one image and recreating the containers - nothing is updated per user. New spaces
 * are seeded from the master's own skills, mcp.json, models.yml and config.yml (`cp -rn`: user edits always win).
 * Provisioning is active only when both OMP_WEB_HOST_IMAGE and OMP_WEB_PUBLIC_URL
 * are configured; without them accounts exist but no container is started, which
 * keeps single-host installs and the test suite untouched.
 *
 * With OMP_WEB_VPN_IMAGE set and an account holding an OpenVPN profile (phase 5),
 * the user's space gains an OpenVPN sidecar sharing the host container's network
 * namespace (pause-container pattern); the sidecar entrypoint enforces the kill
 * switch, so egress only ever leaves through tun0.
 */

export type DockerRunner = (args: string[]) => Promise<string>;

/** One docker invocation as an error message may quote it: the host token value is replaced by `***`. */
export function commandLabel(args: string[]): string {
  return args.map((arg) => (arg.startsWith("OMP_WEB_HOST_TOKEN=") ? "OMP_WEB_HOST_TOKEN=***" : arg)).join(" ");
}

/** Runs a real docker command; injectable everywhere else. */
export const nodeDockerRunner: DockerRunner = (args) => {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile("docker", args, { maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
    if (error) reject(new Error(`docker ${commandLabel(args)}: ${String(stderr || error.message).trim()}`));
    else resolve(String(stdout).trim());
  });
  return promise;
};

export interface UserSpaceConfig {
  /** Image tag of the host image, e.g. `ghcr.io/<org>/ompweb-host:0.7.4-mt.1`. */
  image: string;
  /** URL the hosted daemon links back to, e.g. `http://192.168.1.10:30177`. */
  masterUrl: string;
  /** OpenVPN client image; set together with a stored profile to route the space through a VPN sidecar. */
  vpnImage?: string;
  /** Ship the master's skills and mcp.json to new spaces; on unless explicitly disabled. */
  seedDefaults?: boolean;
  /** Host paths bind-mounted read-only into every user container; `src` mounts at the identical path, `src:dst` at `dst` (shared tool binaries: MCP executables, browser caches). */
  roMounts?: string[];
}

/** The provisioning settings, or null when provisioning is not configured. Pure: never touches docker. */
export function userSpaceConfig(env: NodeJS.ProcessEnv = process.env): UserSpaceConfig | null {
  const image = asString(env.OMP_WEB_HOST_IMAGE)?.trim();
  const masterUrl = asString(env.OMP_WEB_PUBLIC_URL)?.trim();
  if (!image || !masterUrl) return null;
  const vpnImage = asString(env.OMP_WEB_VPN_IMAGE)?.trim();
  const seedRaw = asString(env.OMP_WEB_SEED_DEFAULTS)?.trim().toLowerCase();
  const seedDefaults = seedRaw === "0" || seedRaw === "false" ? false : true;
  const roRaw = asString(env.OMP_WEB_RO_MOUNTS)?.trim();
  const roMounts = roRaw ? roRaw.split(",").map((entry) => entry.trim()).filter((entry) => entry.startsWith("/") && !entry.endsWith(":")) : [];
  return { image, masterUrl, ...(vpnImage ? { vpnImage } : {}), seedDefaults, ...(roMounts.length > 0 ? { roMounts } : {}) };
}

export const hostContainerName = (username: string) => `ompweb-host-${username}`;
export const hostVolumeName = (username: string) => `ompweb-host-${username}-agent`;
export const vpnContainerName = (username: string) => `ompweb-vpn-${username}`;

/** Where a user's provisioned artifacts (host token, VPN profile) live on the master. */
export function spaceDirectory(username: string): string {
  return join(getAgentDir(), "omp-web", "spaces", username);
}

function writeSpaceFile(username: string, name: string, content: string): string {
  const path = join(spaceDirectory(username), name);
  // Nested names (agent-seed/skills/...) need their parent directories too.
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
  // writeFileSync applies the mode only to newly created files; enforce it on rewrites too.
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows has no POSIX mode bits.
  }
  return path;
}

/** The master's shipped agent defaults: its mcp.json, model providers (models.yml), agent config
 * (config.yml) and everything under skills/. Without models.yml a member's host knows no provider and
 * every send fails with "Model not found" even though the master can address the model. */
function collectSeedFiles(agentDir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const mcpPath = join(agentDir, "mcp.json");
  if (existsSync(mcpPath)) files["mcp.json"] = readFileSync(mcpPath, "utf8");
  const modelsPath = join(agentDir, "models.yml");
  if (existsSync(modelsPath)) files["models.yml"] = readFileSync(modelsPath, "utf8");
  const configPath = join(agentDir, "config.yml");
  if (existsSync(configPath)) files["config.yml"] = readFileSync(configPath, "utf8");
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) files[rel] = readFileSync(abs, "utf8");
    }
  };
  const skillsDir = join(agentDir, "skills");
  if (existsSync(skillsDir)) walk(skillsDir, "skills");
  return files;
}

/** Refresh the staging copy of the master's defaults; undefined when seeding is off or nothing exists to seed. */
function stageSeed(username: string, config: UserSpaceConfig): string | undefined {
  if (config.seedDefaults === false) return undefined;
  const files = collectSeedFiles(getAgentDir());
  if (Object.keys(files).length === 0) return undefined;
  const seedDir = join(spaceDirectory(username), "agent-seed");
  rmSync(seedDir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(files)) writeSpaceFile(username, join("agent-seed", rel), content);
  return seedDir;
}

export interface StagedSpace {
  tokenPath: string;
  /** The staged .ovpn path, present when the user has a profile and a VPN image is configured. */
  profilePath?: string;
  /** The staged copy of the master's default agent files, present when seeding produced any. */
  seedPath?: string;
}

/** Write the account's current artifacts (token, optional VPN profile, optional default skills/mcp.json) and return their paths. */
export function stageUserSpace(user: Pick<UserAccount, "username" | "vpnProfile">, config: UserSpaceConfig, hostToken: string): StagedSpace {
  const tokenPath = writeSpaceFile(user.username, "host-token", hostToken);
  const seedPath = stageSeed(user.username, config);
  if (config.vpnImage && user.vpnProfile) {
    return { tokenPath, profilePath: writeSpaceFile(user.username, "config.ovpn", user.vpnProfile), seedPath };
  }
  return { tokenPath, seedPath };
}

/** The exact docker invocations a provision performs, derived purely from the inputs. */
export function buildProvisionCommands(username: string, config: UserSpaceConfig, hostToken: string, vpnProfilePath?: string, seedPath?: string): string[][] {
  const vpn = config.vpnImage !== undefined && vpnProfilePath !== undefined ? { image: config.vpnImage, profile: vpnProfilePath } : undefined;
  const commands: string[][] = [["volume", "create", hostVolumeName(username)]];
  if (vpn) {
    commands.push(["run", "-d", "--name", vpnContainerName(username), "--restart", "unless-stopped", "--cap-add", "NET_ADMIN", "-v", `${vpn.profile}:/etc/openvpn/config.ovpn:ro`, vpn.image]);
  }
  if (seedPath) {
    // Fill the volume with the master's defaults; `cp -rn` never overwrites files the user already has.
    // The host image's ENTRYPOINT is entrypoint-host.sh (`exec ompweb host "$@"`), so the one-shot
    // must override it via --entrypoint sh, and it runs --user root: the staged files are mode 0600
    // (mcp.json holds secrets) and only root can read them and chown the result to omp.
    commands.push(["run", "--rm", "--user", "root", "--entrypoint", "sh", "-v", `${seedPath}:/seed:ro`, "-v", `${hostVolumeName(username)}:/home/omp/.omp/agent`, config.image, "-c", "cp -rn /seed/. /home/omp/.omp/agent/ && chown -R omp:omp /home/omp/.omp/agent"]);
  }
  // Chrome-for-Testing as uid 10000: its crashpad_handler needs CAP_SYS_PTRACE (Docker's default cap set
  // omits it) and the default seccomp profile blocks the clone/namespace syscalls it uses, so without both
  // flags the member's browser dies with "chrome_crashpad_handler: --database is required" / SIGTRAP.
  const hostRun = ["run", "-d", "--name", hostContainerName(username), "--restart", "unless-stopped", "--cap-add", "SYS_PTRACE", "--security-opt", "seccomp=unconfined"];
  if (vpn) hostRun.push("--network", `container:${vpnContainerName(username)}`);
  for (const mount of config.roMounts ?? []) {
    const [src, dst] = mount.split(":");
    hostRun.push("-v", `${src}:${dst ?? src}:ro`);
  }
  hostRun.push("-v", `${hostVolumeName(username)}:/home/omp/.omp/agent`, "-e", `OMP_WEB_HOST_URL=${config.masterUrl}`, `-e`, `OMP_WEB_HOST_TOKEN=${hostToken}`, config.image);
  commands.push(hostRun);
  return commands;
}

/** The exact docker invocations a teardown performs; data removal lives in the volume. */
export function buildTeardownCommands(username: string, withVpn = false): string[][] {
  return [
    ["rm", "-f", "-v", hostContainerName(username)],
    ...(withVpn ? [["rm", "-f", vpnContainerName(username)]] : []),
    ["volume", "rm", hostVolumeName(username)],
  ];
}

async function runAll(commands: string[][], run: DockerRunner): Promise<void> {
  for (const args of commands) await run(args);
}

/** True when the account currently has a VPN profile staged on disk. */
export function hasStagedVpn(username: string): boolean {
  return existsSync(join(spaceDirectory(username), "config.ovpn"));
}

/**
 * Creates the host record for `user`, assigns it to them, and starts their container(s).
 * Any failure after the registration rolls the whole attempt back: the host record is
 * revoked, containers the attempt already started are removed, and the staged artifacts
 * are deleted, so a retry starts clean.
 */
export async function provisionUserSpace(
  user: Pick<UserAccount, "id" | "username" | "vpnProfile">,
  config: UserSpaceConfig,
  run: DockerRunner = nodeDockerRunner,
): Promise<{ hostId: string }> {
  const { host, token } = createHost(user.username);
  try {
    updateHost(host.id, { ownerUserId: user.id });
    const staged = stageUserSpace(user, config, token);
    await runAll(buildProvisionCommands(user.username, config, token, staged.profilePath, staged.seedPath), run);
    return { hostId: host.id };
  } catch (error) {
    revokeHost(host.id);
    // Containers the attempt already started must go too: a leftover would fail the
    // retry's `docker run`. Missing containers are tolerated, as in teardown.
    await run(["rm", "-f", "-v", hostContainerName(user.username)]).catch(() => undefined);
    await run(["rm", "-f", vpnContainerName(user.username)]).catch(() => undefined);
    // The staged artifacts belonged to the revoked registration: drop them so a retry stages fresh ones.
    rmSync(join(spaceDirectory(user.username), "host-token"), { force: true });
    rmSync(join(spaceDirectory(user.username), "config.ovpn"), { force: true });
    rmSync(join(spaceDirectory(user.username), "agent-seed"), { recursive: true, force: true });
    throw error;
  }
}

/**
 * Re-create an existing space with the account's current settings (used when the VPN
 * profile changes: the host container must be rebuilt to attach/detach the shared netns).
 * The host token is reused from the staged artifacts of the original provision.
 */
export async function reprovisionUserSpace(
  user: Pick<UserAccount, "username" | "vpnProfile">,
  config: UserSpaceConfig,
  run: DockerRunner = nodeDockerRunner,
): Promise<void> {
  const tokenPath = join(spaceDirectory(user.username), "host-token");
  if (!existsSync(tokenPath)) throw new Error(`${user.username} has no provisioned space to rebuild`);
  const token = readFileSync(tokenPath, "utf8").trim();
  const hadVpn = hasStagedVpn(user.username);
  const staged = stageUserSpace(user, config, token);
  const willHaveVpn = Boolean(staged.profilePath);
  // Remove both old containers whenever either exists: the host container may still be attached to
  // the VPN sidecar's network namespace, and a leftover would fail the rebuild's `docker run`.
  // Missing containers are tolerated, exactly as teardown removes both unconditionally.
  await run(["rm", "-f", "-v", hostContainerName(user.username)]).catch(() => undefined);
  if (hadVpn || willHaveVpn) await run(["rm", "-f", vpnContainerName(user.username)]).catch(() => undefined);
  await runAll(buildProvisionCommands(user.username, config, token, staged.profilePath, staged.seedPath), run);
}

/** Stops the user's containers (ban); missing containers are tolerated. */
export async function stopUserSpace(username: string, run: DockerRunner = nodeDockerRunner): Promise<void> {
  await run(["stop", hostContainerName(username)]).catch(() => undefined);
  if (hasStagedVpn(username)) await run(["stop", vpnContainerName(username)]).catch(() => undefined);
}

/** Starts an existing stopped space (unban); false when nothing can be started. A staged VPN sidecar starts first: the host container joins its network namespace. */
export async function startUserSpace(username: string, run: DockerRunner = nodeDockerRunner): Promise<boolean> {
  if (hasStagedVpn(username) && !(await run(["start", vpnContainerName(username)]).then(() => true, () => false))) return false;
  try {
    await run(["start", hostContainerName(username)]);
    return true;
  } catch {
    return false;
  }
}

/** Removes container(s) and volume; used on account deletion after the row itself is gone. */
export async function teardownUserSpace(username: string, run: DockerRunner = nodeDockerRunner): Promise<void> {
  await runAll(buildTeardownCommands(username, hasStagedVpn(username)), run);
}

/** Revokes every host record owned by `userId`; returns the revoked ids. */
export function revokeOwnedHosts(userId: number): string[] {
  const ids = readHosts().filter((host) => host.ownerUserId === userId).map((host) => host.id);
  for (const id of ids) revokeHost(id);
  return ids;
}
