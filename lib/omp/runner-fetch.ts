import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import packageJson from "../../package.json";
import { releaseRepo } from "../release-repo";
import { downloadHostUpdateFile, fetchHostUpdateBytes, HOST_RELEASE_MAX_MEMBER } from "../hosts/update-worker";
import { createChildProcessEnvironment } from "../project-command-env";
import { isRecord } from "../type-guards";
import { fetchedOmpBin, OMP_RUNNER_ASSET, OMP_TAG, ompRunnerPath, ompRunnerRoot, readOmpPointer, resolveOmpBin, sourceCheckoutOmpBin, writeOmpPointer } from "./omp-cli";

// Every install gets its omp runner (ompweb-omp) from its own version's GitHub release: the asset OMP_RUNNER_ASSET,
// checked against that release's OMP_RUNNER_CHECKSUMS. Releases attach both (.github/workflows/publish.yml).
// Between ompweb releases, "Update omp" takes the same two files from a runner-only release,
// `runner-<ompweb version>-<omp tag>` (.github/workflows/omp-runner-release.yml).
// Loaded by Node/jiti and the compiled binary: no `@/` imports.

/** The `sha256sum` listing of every runner asset a release attaches. */
export const OMP_RUNNER_CHECKSUMS = "ompweb-omp.sha256";

/** Downloads `<base>/<OMP_RUNNER_ASSET>` to `target` (atomically, executable) once its SHA-256 matches the one
 * `<base>/<OMP_RUNNER_CHECKSUMS>` lists; returns that SHA-256. */
async function downloadRunner(base: string, target: string): Promise<string> {
  const url = `${base}/${OMP_RUNNER_ASSET}`;
  const partial = `${target}.${process.pid}.${Date.now()}.partial`;
  try {
    const sums = (await fetchHostUpdateBytes(`${base}/${OMP_RUNNER_CHECKSUMS}`, 64 * 1024, 30_000)).toString("utf8");
    const expected = sums.split("\n").map((line) => line.trim().split(/\s+\*?/)).find(([, name]) => name === OMP_RUNNER_ASSET)?.[0];
    if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`${OMP_RUNNER_CHECKSUMS} lists no ${OMP_RUNNER_ASSET}`);
    mkdirSync(dirname(target), { recursive: true });
    const digest = await downloadHostUpdateFile(url, partial, HOST_RELEASE_MAX_MEMBER);
    if (digest !== `sha256:${expected}`) throw new Error(`its SHA-256 is not the one ${OMP_RUNNER_CHECKSUMS} lists`);
    chmodSync(partial, 0o755);
    renameSync(partial, target);
    return expected;
  } catch (error) {
    rmSync(partial, { force: true });
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not fetch ompweb's omp from ${url}: ${reason}. Check this machine's connection to GitHub, or set OMP_WEB_OMP_BIN to an ompweb-omp binary.`);
  }
}

/** Downloads this version's runner to `target` (atomically, executable) once its SHA-256 matches the release's. */
export async function fetchOmpRunner(target = fetchedOmpBin(), version = packageJson.version): Promise<string> {
  await downloadRunner(`https://github.com/${releaseRepo()}/releases/download/v${version}`, target);
  return target;
}

/** A runner-only release: its omp tag (`v<ompVersion>-int.<stamp>.g<sha7>`) and that tag's build stamp, `YYYYMMDDHHMM`. */
export interface OmpRunnerRelease {
  ompTag: string;
  stamp: string;
}

/** The newest release of `releases` (GitHub's release listing) named `runner-<ompweb>-<omp tag>`, by the omp tag's stamp.
 * Other ompweb versions, drafts and tags that are not exactly that shape are ignored. */
export function newestRunnerRelease(releases: unknown, ompweb = packageJson.version): OmpRunnerRelease | null {
  const prefix = `runner-${ompweb}-`;
  let newest: OmpRunnerRelease | null = null;
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!isRecord(release) || release.draft === true || typeof release.tag_name !== "string" || !release.tag_name.startsWith(prefix)) continue;
    const ompTag = release.tag_name.slice(prefix.length);
    if (!OMP_TAG.test(ompTag)) continue;
    const stamp = /-int\.(\d{12})\./.exec(ompTag)![1];
    if (!newest || stamp > newest.stamp) newest = { ompTag, stamp };
  }
  return newest;
}

const RELEASES_TTL_MS = 5 * 60_000;
const RELEASES_FAILURE_TTL_MS = 30_000;
let releasesCheck: { at: number; failed: boolean; result: Promise<OmpRunnerRelease | null> } | undefined;
/** The newest runner-only release for this ompweb version, null when it has none. The listing is cached (a status poll
 * must not spend GitHub's unauthenticated rate limit); `refresh` bypasses the cache. */
export function latestOmpRunnerRelease(refresh = false): Promise<OmpRunnerRelease | null> {
  if (!refresh && releasesCheck && Date.now() - releasesCheck.at < (releasesCheck.failed ? RELEASES_FAILURE_TTL_MS : RELEASES_TTL_MS)) return releasesCheck.result;
  const check: NonNullable<typeof releasesCheck> = {
    at: Date.now(),
    failed: false,
    result: fetchHostUpdateBytes(`https://api.github.com/repos/${releaseRepo()}/releases?per_page=100`, 8 * 1024 * 1024, 15_000)
      .then((bytes) => newestRunnerRelease(JSON.parse(bytes.toString("utf8"))))
      .catch((error: unknown) => { check.failed = true; throw error; }),
  };
  releasesCheck = check;
  return check.result;
}

const execFileAsync = promisify(execFile);
/** The runner reports the omp version it was built from and passes omp's own start-up checks. */
async function probeOmpRunner(bin: string, version: string): Promise<void> {
  const env = createChildProcessEnvironment();
  // 60 s: a fresh ~120 MB runner's first start on Windows waits on the antivirus scan.
  const run = (argument: string) => execFileAsync(bin, [argument], { timeout: 60_000, windowsHide: true, env });
  const reported = (await run("--version")).stdout.trim();
  if (reported.replace(/^omp\//, "") !== version) throw new Error(`it reports version ${reported || "(none)"}, not ${version}`);
  await run("--smoke-test");
}

/**
 * "Update omp": installs the runner of the release `runner-<ompweb>-<tag>` as a new file `<tag>/ompweb-omp[.exe]` under
 * this version's runner directory (never over a runner a session may be executing: Windows refuses that, and running
 * sessions keep theirs), verifies its SHA-256 and probes it, and only then points `current.json` at it. A download that
 * fails its checksum or probe leaves the pointer, and the runner in use, as they were. Returns the installed path.
 * `probe` is a seam for tests.
 */
export async function installOmpRunner(tag: string, ompweb = packageJson.version, probe = probeOmpRunner): Promise<string> {
  if (!OMP_TAG.test(tag)) throw new Error(`${tag} is not an omp build tag`);
  const target = ompRunnerPath(tag, ompweb);
  // Leftovers of an earlier failed attempt, or a damaged copy the pointer names: this install replaces them.
  rmSync(dirname(target), { recursive: true, force: true });
  try {
    const sha256 = await downloadRunner(`https://github.com/${releaseRepo()}/releases/download/runner-${ompweb}-${tag}`, target);
    try { await probe(target, tag.slice(1)); }
    catch (error) { throw new Error(`omp ${tag} downloaded but did not pass its checks: ${error instanceof Error ? error.message : String(error)}`); }
    writeOmpPointer({ tag, path: target, sha256 }, ompweb);
  } catch (error) {
    rmSync(dirname(target), { recursive: true, force: true });
    throw error;
  }
  return target;
}

/** At daemon start: removes every runner-only release's directory but the pointed one (and a failed install's
 * leftovers). A runner a process still holds open (Windows) stays until the next start. */
export function sweepOmpRunners(ompweb = packageJson.version): void {
  const keep = readOmpPointer(ompweb)?.tag;
  const root = ompRunnerRoot(ompweb);
  let names: string[];
  try { names = readdirSync(root); } catch { return; }
  for (const name of names) {
    if (name === keep || !OMP_TAG.test(name)) continue;
    try { rmSync(join(root, name), { recursive: true, force: true }); } catch { /* in use: the next start retries */ }
  }
}

let ensuring: Promise<string | null> | null = null;
/** The runner, fetched first when this install has none; null in a source checkout that has not built one. One fetch
 * at a time per process; a web server and a daemon fetching together each write their own partial file. */
export function ensureOmpRunner(): Promise<string | null> {
  ensuring ??= (async () => {
    const found = resolveOmpBin(true);
    if (found || process.env.OMP_WEB_OMP_BIN || sourceCheckoutOmpBin()) return found;
    await fetchOmpRunner();
    return resolveOmpBin(true);
  })().finally(() => { ensuring = null; });
  return ensuring;
}

/** `ompweb fetch-omp`: what updaters run on a candidate release before its preflight; exit 1 names what failed. */
export async function runFetchOmp(): Promise<number> {
  try {
    const bin = await ensureOmpRunner();
    if (!bin) throw new Error(process.env.OMP_WEB_OMP_BIN ? `OMP_WEB_OMP_BIN=${process.env.OMP_WEB_OMP_BIN} does not exist` : `this source checkout has no ${sourceCheckoutOmpBin()}: build it with \`bun runner/scripts/build-binary.ts\``);
    console.log(`omp: ${bin}`);
    return 0;
  } catch (error) {
    console.error(`fetch-omp failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
