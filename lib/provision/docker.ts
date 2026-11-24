import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
 * one image and recreating the containers - nothing is updated per user.
 *
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

/** Runs a real docker command; injectable everywhere else. */
export const nodeDockerRunner: DockerRunner = (args) => {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile("docker", args, { maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
    if (error) reject(new Error(`docker ${args.join(" ")}: ${String(stderr || error.message).trim()}`));
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
}

/** The provisioning settings, or null when provisioning is not configured. Pure: never touches docker. */
export function userSpaceConfig(env: NodeJS.ProcessEnv = process.env): UserSpaceConfig | null {
  const image = asString(env.OMP_WEB_HOST_IMAGE)?.trim();
  const masterUrl = asString(env.OMP_WEB_PUBLIC_URL)?.trim();
  if (!image || !masterUrl) return null;
  const vpnImage = asString(env.OMP_WEB_VPN_IMAGE)?.trim();
  return vpnImage ? { image, masterUrl, vpnImage } : { image, masterUrl };
}

export const hostContainerName = (username: string) => `ompweb-host-${username}`;
export const hostVolumeName = (username: string) => `ompweb-host-${username}-agent`;
export const vpnContainerName = (username: string) => `ompweb-vpn-${username}`;

/** Where a user's provisioned artifacts (host token, VPN profile) live on the master. */
export function spaceDirectory(username: string): string {
  return join(getAgentDir(), "omp-web", "spaces", username);
}

function writeSpaceFile(username: string, name: string, content: string): string {
  const dir = spaceDirectory(username);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

export interface StagedSpace {
  tokenPath: string;
  /** The staged .ovpn path, present when the user has a profile and a VPN image is configured. */
  profilePath?: string;
}

/** Write the account's current artifacts (token, optional VPN profile) and return their paths. */
export function stageUserSpace(user: Pick<UserAccount, "username" | "vpnProfile">, config: UserSpaceConfig, hostToken: string): StagedSpace {
  const tokenPath = writeSpaceFile(user.username, "host-token", hostToken);
  if (config.vpnImage && user.vpnProfile) {
    return { tokenPath, profilePath: writeSpaceFile(user.username, "config.ovpn", user.vpnProfile) };
  }
  return { tokenPath };
}

/** The exact docker invocations a provision performs, derived purely from the inputs. */
export function buildProvisionCommands(username: string, config: UserSpaceConfig, hostToken: string, vpnProfilePath?: string): string[][] {
  const vpn = config.vpnImage !== undefined && vpnProfilePath !== undefined ? { image: config.vpnImage, profile: vpnProfilePath } : undefined;
  const commands: string[][] = [["volume", "create", hostVolumeName(username)]];
  if (vpn) {
    commands.push(["run", "-d", "--name", vpnContainerName(username), "--restart", "unless-stopped", "--cap-add", "NET_ADMIN", "-v", `${vpn.profile}:/etc/openvpn/config.ovpn:ro`, vpn.image]);
  }
  const hostRun = ["run", "-d", "--name", hostContainerName(username), "--restart", "unless-stopped"];
  if (vpn) hostRun.push("--network", `container:${vpnContainerName(username)}`);
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
 * A docker failure rolls the host registration back so a retry starts clean.
 */
export async function provisionUserSpace(
  user: Pick<UserAccount, "id" | "username" | "vpnProfile">,
  config: UserSpaceConfig,
  run: DockerRunner = nodeDockerRunner,
): Promise<{ hostId: string }> {
  const { host, token } = createHost(user.username);
  updateHost(host.id, { ownerUserId: user.id });
  const staged = stageUserSpace(user, config, token);
  try {
    await runAll(buildProvisionCommands(user.username, config, token, staged.profilePath), run);
  } catch (error) {
    revokeHost(host.id);
    // The staged artifacts belonged to the revoked registration: drop them so a retry stages fresh ones.
    rmSync(join(spaceDirectory(user.username), "host-token"), { force: true });
    rmSync(join(spaceDirectory(user.username), "config.ovpn"), { force: true });
    throw error;
  }
  return { hostId: host.id };
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
  await runAll(buildProvisionCommands(user.username, config, token, staged.profilePath), run);
}

/** Stops the user's container (ban); missing containers are tolerated. */
export async function stopUserSpace(username: string, run: DockerRunner = nodeDockerRunner): Promise<void> {
  await run(["stop", hostContainerName(username)]).catch(() => undefined);
}

/** Starts an existing stopped container (unban); false when the user has no container to start. */
export async function startUserSpace(username: string, run: DockerRunner = nodeDockerRunner): Promise<boolean> {
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
