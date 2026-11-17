import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const { fetchOmpRunner, OMP_RUNNER_CHECKSUMS } = await import("./runner-fetch.ts");
const { OMP_RUNNER_ASSET } = await import("./omp-cli.ts");
const { releaseRepo } = await import("../release-repo.ts");
const dir = mkdtempSync(join(tmpdir(), "ompweb-runner-fetch-"));
const original = globalThis.fetch;
after(() => { globalThis.fetch = original; rmSync(dir, { recursive: true, force: true }); });

const runner = Buffer.from("#!/bin/sh\necho runner\n");
const sha = createHash("sha256").update(runner).digest("hex");
const base = `https://github.com/${releaseRepo()}/releases/download/v9.9.9`;
/** Serves the release's checksum listing and runner; `served` records each URL asked for. */
function serve(sums, served = []) {
  globalThis.fetch = async (url) => {
    served.push(String(url));
    if (String(url) === `${base}/${OMP_RUNNER_CHECKSUMS}`) return new Response(sums);
    if (String(url) === `${base}/${OMP_RUNNER_ASSET}`) return new Response(runner);
    return new Response("missing", { status: 404 });
  };
  return served;
}

test("the runner comes from this version's release, checked against its checksum listing, and lands executable", async () => {
  const served = serve(`${"0".repeat(64)}  ompweb-omp-other\n${sha}  ${OMP_RUNNER_ASSET}\n`);
  const target = join(dir, "ok", "ompweb-omp");
  assert.equal(await fetchOmpRunner(target, "9.9.9"), target);
  assert.deepEqual(readFileSync(target), runner);
  if (process.platform !== "win32") assert.equal(statSync(target).mode & 0o777, 0o755);
  assert.deepEqual(served, [`${base}/${OMP_RUNNER_CHECKSUMS}`, `${base}/${OMP_RUNNER_ASSET}`]);
  assert.deepEqual(readdirSync(join(dir, "ok")), ["ompweb-omp"], "no partial file is left");
});

test("a runner whose SHA-256 differs from the listed one is refused and nothing is written", async () => {
  serve(`${"a".repeat(64)}  ${OMP_RUNNER_ASSET}\n`);
  const target = join(dir, "mismatch", "ompweb-omp");
  await assert.rejects(fetchOmpRunner(target, "9.9.9"), /SHA-256/);
  assert.equal(existsSync(target), false);
  assert.deepEqual(readdirSync(join(dir, "mismatch")), []);
  serve(`${sha}  ompweb-omp-other\n`);
  await assert.rejects(fetchOmpRunner(target, "9.9.9"), new RegExp(`lists no ${OMP_RUNNER_ASSET}`));
});

test("offline, the error names the runner URL and OMP_WEB_OMP_BIN", async () => {
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  const target = join(dir, "offline", "ompweb-omp");
  await assert.rejects(fetchOmpRunner(target, "9.9.9"), (error) => {
    assert.ok(error.message.includes(`${base}/${OMP_RUNNER_ASSET}`), error.message);
    assert.match(error.message, /fetch failed.*OMP_WEB_OMP_BIN/);
    return true;
  });
  assert.equal(existsSync(target), false);
});

test("the release repository is package.json's", async () => {
  const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(`git+https://github.com/${releaseRepo()}.git`, packageJson.repository.url);
});

const { installOmpRunner, newestRunnerRelease, sweepOmpRunners } = await import("./runner-fetch.ts");
const { ompRunnerPath, ompRunnerRoot, readOmpPointer } = await import("./omp-cli.ts");
const release = (tag_name, extra = {}) => ({ tag_name, prerelease: true, ...extra });

test("the newest runner release for this ompweb version is chosen by its omp tag's stamp; everything else is ignored", () => {
  const releases = [
    release("runner-9.9.9-v18.22.0-int.202611171027.gec3956c"),
    release("runner-9.9.9-v18.23.0-int.202611201200.gabc1234"),
    release("runner-9.9.99-v18.24.0-int.202611220000.gaaaaaaa"), // another ompweb version sharing the prefix
    release("runner-9.9.8-v18.24.0-int.202611220000.gaaaaaaa"),
    release("runner-9.9.9-v18.24.0-int.202611220000.gdddddddd", { draft: true }),
    release("runner-9.9.9-v18.24.0-int.20261122.gaaaaaaa"), // malformed stamp
    release("runner-9.9.9-v18.24.0-int.202611220000.gAAAAAAA"), // malformed sha
    release("runner-9.9.9-v18.24.0"), // not an integration build
    release("runner-9.9.9-v18.24.0-int.202611220000.gaaaaaaa/../x"),
    release("v9.9.9"),
    release("20261101T103000Z-abcdef0123"),
    { tag_name: 7 },
    null,
  ];
  assert.deepEqual(newestRunnerRelease(releases, "9.9.9"), { ompTag: "v18.23.0-int.202611201200.gabc1234", stamp: "202611201200" });
  assert.deepEqual(newestRunnerRelease([...releases].reverse(), "9.9.9")?.ompTag, "v18.23.0-int.202611201200.gabc1234", "the listing's order does not matter");
  assert.equal(newestRunnerRelease(releases, "1.0.0"), null);
  assert.equal(newestRunnerRelease({ message: "rate limited" }, "9.9.9"), null);
});

const TAG = "v18.23.0-int.202611201200.gabc1234";
const OLD_TAG = "v18.22.0-int.202611171027.gec3956c";
const runnerBase = (tag) => `https://github.com/${releaseRepo()}/releases/download/runner-9.9.9-${tag}`;
/** Serves each runner release's checksum listing and binary; a binary maps to the SHA-256 its listing claims. */
function serveRunners(releases) {
  globalThis.fetch = async (url) => {
    for (const [tag, { binary, listed }] of Object.entries(releases)) {
      if (String(url) === `${runnerBase(tag)}/${OMP_RUNNER_CHECKSUMS}`) return new Response(`${listed}  ${OMP_RUNNER_ASSET}\n`);
      if (String(url) === `${runnerBase(tag)}/${OMP_RUNNER_ASSET}`) return new Response(binary);
    }
    return new Response("missing", { status: 404 });
  };
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const asBuild = (tag) => Buffer.from(`#!/bin/sh\necho omp/${tag.slice(1)}\n`);
const pointerFile = () => join(ompRunnerRoot("9.9.9"), "current.json");

let agents = 0;
async function inAgentDir(t) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(dir, `agent-${agents++}`);
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
}

test("an omp build is installed as a new file, probed, and only then pointed at", async (t) => {
  await inAgentDir(t);
  const build = asBuild(TAG);
  serveRunners({ [TAG]: { binary: build, listed: digest(build) } });
  const probes = [];
  const path = await installOmpRunner(TAG, "9.9.9", async (bin, version) => { probes.push([bin, version, existsSync(pointerFile())]); });
  assert.equal(path, ompRunnerPath(TAG, "9.9.9"));
  assert.deepEqual(readFileSync(path), build);
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o755);
  assert.deepEqual(probes, [[path, TAG.slice(1), false]], "the probe runs on the file before the pointer exists");
  assert.deepEqual(readOmpPointer("9.9.9"), { tag: TAG, path, sha256: digest(build) });
  assert.deepEqual(readdirSync(join(ompRunnerRoot("9.9.9"), TAG)), [process.platform === "win32" ? "ompweb-omp.exe" : "ompweb-omp"], "no partial file is left");
});

test("a checksum mismatch refuses the install and leaves the pointer and the runner in use untouched", async (t) => {
  await inAgentDir(t);
  const old = asBuild(OLD_TAG);
  serveRunners({ [OLD_TAG]: { binary: old, listed: digest(old) } });
  const inUse = await installOmpRunner(OLD_TAG, "9.9.9", async () => {});
  const pointer = readFileSync(pointerFile(), "utf8");

  serveRunners({ [TAG]: { binary: asBuild(TAG), listed: digest("something else") } });
  await assert.rejects(installOmpRunner(TAG, "9.9.9", async () => assert.fail("a refused download is never run")), /SHA-256/);
  assert.equal(readFileSync(pointerFile(), "utf8"), pointer);
  assert.deepEqual(readFileSync(inUse), old);
  assert.equal(existsSync(join(ompRunnerRoot("9.9.9"), TAG)), false, "nothing of the refused build stays");
});

test("a build that fails its probe is removed and the pointer stays where it was", async (t) => {
  await inAgentDir(t);
  const build = asBuild(TAG);
  serveRunners({ [TAG]: { binary: build, listed: digest(build) } });
  await assert.rejects(installOmpRunner(TAG, "9.9.9", async () => { throw new Error("smoke test failed"); }), /did not pass its checks: smoke test failed/);
  assert.equal(existsSync(pointerFile()), false);
  assert.equal(existsSync(join(ompRunnerRoot("9.9.9"), TAG)), false);
});

test("only an omp build tag is installed, and a start-up sweep keeps just the pointed build", async (t) => {
  await inAgentDir(t);
  await assert.rejects(installOmpRunner("v18.23.0/../../x", "9.9.9"), /not an omp build tag/);
  const [old, build] = [asBuild(OLD_TAG), asBuild(TAG)];
  serveRunners({ [OLD_TAG]: { binary: old, listed: digest(old) }, [TAG]: { binary: build, listed: digest(build) } });
  await installOmpRunner(OLD_TAG, "9.9.9", async () => {});
  await installOmpRunner(TAG, "9.9.9", async () => {});
  const root = ompRunnerRoot("9.9.9");
  mkdirSync(join(root, "not-a-build"));
  sweepOmpRunners("9.9.9");
  assert.deepEqual(readdirSync(root).sort(), ["current.json", "not-a-build", TAG]);
});
