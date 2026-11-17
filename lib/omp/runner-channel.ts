import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import packageJson from "../../package.json";
import { downloadHostUpdateFile, fetchHostUpdateBytes, HOST_RELEASE_MAX_MEMBER } from "../hosts/update-worker";
import { isNewerVersion } from "../version-compare";
import { channelOmpBin, OMP_RUNNER_ASSET, resetOmpBinCache } from "./omp-cli";

/** Rolling release that carries a newer ompweb-omp without a new ompweb tag. */
export const RUNNER_CHANNEL_TAG = "ompweb-runner";
export const RUNNER_CHANNEL_REPO = "ompweb-dev/ompweb";

export interface RunnerChannel {
  omp: string;
  minHost: string;
  sha256: string;
  asset: string;
}

export interface RunnerChannelStatus {
  availableVersion: string | null;
  updateAvailable: boolean;
  canUpdate: boolean;
  blockedReason: string | null;
}

export function runnerChannelBase(repo = RUNNER_CHANNEL_REPO, tag = RUNNER_CHANNEL_TAG): string {
  return `https://github.com/${repo}/releases/download/${tag}`;
}

/** This host may install the channel when it is the minimum host or newer. */
export function runnerChannelSupported(minHost: string, host = packageJson.version): boolean {
  return minHost === host || isNewerVersion(host, minHost);
}

export function parseRunnerChannel(raw: string, asset = OMP_RUNNER_ASSET): RunnerChannel {
  const parsed = JSON.parse(raw) as { omp?: unknown; minHost?: unknown; assets?: unknown };
  if (typeof parsed.omp !== "string" || parsed.omp.length === 0) throw new Error("runner channel has no omp version");
  if (typeof parsed.minHost !== "string" || !/^\d+\.\d+\.\d+$/.test(parsed.minHost)) throw new Error("runner channel has no minHost");
  if (parsed.assets === null || typeof parsed.assets !== "object") throw new Error("runner channel has no assets");
  const sha256 = (parsed.assets as Record<string, unknown>)[asset];
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`runner channel lists no ${asset}`);
  return { omp: parsed.omp, minHost: parsed.minHost, sha256, asset };
}

export function fileSha256(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

export async function readRunnerChannel(base = runnerChannelBase()): Promise<RunnerChannel> {
  const bytes = await fetchHostUpdateBytes(`${base}/runner.json`, 64 * 1024, 30_000);
  return parseRunnerChannel(bytes.toString("utf8"));
}

/** A missing channel does not fail the ompweb check. An operator pin is left alone. */
export async function runnerChannelStatus(currentBin: string | null): Promise<RunnerChannelStatus> {
  const none: RunnerChannelStatus = { availableVersion: null, updateAvailable: false, canUpdate: false, blockedReason: null };
  if (process.env.OMP_WEB_OMP_BIN) return none;
  try {
    const channel = await readRunnerChannel();
    if (!runnerChannelSupported(channel.minHost)) return { ...none, blockedReason: `This host is older than ${channel.minHost}` };
    const current = currentBin ? fileSha256(currentBin) : null;
    if (current === null || current === channel.sha256) return none;
    return { availableVersion: channel.omp, updateAvailable: true, canUpdate: true, blockedReason: null };
  } catch {
    return none;
  }
}

export async function startRunnerChannelUpdate(version: string): Promise<{ accepted: true; operation: { id: string; target: "omp"; version: string; state: "succeeded" } }> {
  const channel = await readRunnerChannel();
  if (channel.omp !== version) throw new Error("runner channel changed; check again");
  await installRunnerChannel(channel);
  return { accepted: true, operation: { id: randomUUID(), target: "omp", version, state: "succeeded" } };
}

/** Replaces the channel binary. Refuses an operator pin and a host older than minHost. */
export async function installRunnerChannel(channel: RunnerChannel, target = channelOmpBin(), base = runnerChannelBase()): Promise<string> {
  if (process.env.OMP_WEB_OMP_BIN) throw new Error("OMP_WEB_OMP_BIN is set; the channel will not replace it");
  if (!runnerChannelSupported(channel.minHost)) throw new Error(`this host ${packageJson.version} is older than minHost ${channel.minHost}`);
  const partial = `${target}.${process.pid}.${Date.now()}.partial`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    const digest = await downloadHostUpdateFile(`${base}/${channel.asset}`, partial, HOST_RELEASE_MAX_MEMBER);
    if (digest !== `sha256:${channel.sha256}`) throw new Error("its SHA-256 is not the one runner.json lists");
    chmodSync(partial, 0o755);
    renameSync(partial, target);
    resetOmpBinCache();
    return target;
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
}
