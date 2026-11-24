import { execFile } from "node:child_process";
import { createHost, readHosts, revokeHost, updateHost } from "../hosts/registry";
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
}

/** The provisioning settings, or null when provisioning is not configured. Pure: never touches docker. */
export function userSpaceConfig(env: NodeJS.ProcessEnv = process.env): UserSpaceConfig | null {
  const image = asString(env.OMP_WEB_HOST_IMAGE)?.trim();
  const masterUrl = asString(env.OMP_WEB_PUBLIC_URL)?.trim();
  if (!image || !masterUrl) return null;
  return { image, masterUrl };
}

export const hostContainerName = (username: string) => `ompweb-host-${username}`;
export const hostVolumeName = (username: string) => `ompweb-host-${username}-agent`;

/** The exact docker invocations a provision performs, derived purely from the inputs. */
export function buildProvisionCommands(username: string, config: UserSpaceConfig, hostToken: string): string[][] {
  return [
    ["volume", "create", hostVolumeName(username)],
    [
      "run",
      "-d",
      "--name",
      hostContainerName(username),
      "--restart",
      "unless-stopped",
      "-v",
      `${hostVolumeName(username)}:/home/omp/.omp/agent`,
      "-e",
      `OMP_WEB_HOST_URL=${config.masterUrl}`,
      "-e",
      `OMP_WEB_HOST_TOKEN=${hostToken}`,
      config.image,
    ],
  ];
}

/** The exact docker invocations a teardown performs; data removal lives in the volume. */
export function buildTeardownCommands(username: string): string[][] {
  return [
    ["rm", "-f", "-v", hostContainerName(username)],
    ["volume", "rm", hostVolumeName(username)],
  ];
}

async function runAll(commands: string[][], run: DockerRunner): Promise<void> {
  for (const args of commands) await run(args);
}

/**
 * Creates the host record for `user`, assigns it to them, and starts their container.
 * A docker failure rolls the host registration back so a retry starts clean.
 */
export async function provisionUserSpace(
  user: Pick<UserAccount, "id" | "username">,
  config: UserSpaceConfig,
  run: DockerRunner = nodeDockerRunner,
): Promise<{ hostId: string }> {
  const { host, token } = createHost(user.username);
  updateHost(host.id, { ownerUserId: user.id });
  try {
    await runAll(buildProvisionCommands(user.username, config, token), run);
  } catch (error) {
    revokeHost(host.id);
    throw error;
  }
  return { hostId: host.id };
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

/** Removes container and volume; used on account deletion after the row itself is gone. */
export async function teardownUserSpace(username: string, run: DockerRunner = nodeDockerRunner): Promise<void> {
  await runAll(buildTeardownCommands(username), run);
}

/** Revokes every host record owned by `userId`; returns the revoked ids. */
export function revokeOwnedHosts(userId: number): string[] {
  const ids = readHosts().filter((host) => host.ownerUserId === userId).map((host) => host.id);
  for (const id of ids) revokeHost(id);
  return ids;
}
