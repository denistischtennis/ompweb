import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const { installRunnerChannel, parseRunnerChannel, runnerChannelSupported } = await import("./runner-channel.ts");
const { OMP_RUNNER_ASSET } = await import("./omp-cli.ts");
const dir = mkdtempSync(join(tmpdir(), "ompweb-runner-channel-"));
const original = globalThis.fetch;
after(() => { globalThis.fetch = original; rmSync(dir, { recursive: true, force: true }); });

const runner = Buffer.from("#!/bin/sh\necho channel-runner\n");
const sha = createHash("sha256").update(runner).digest("hex");
const base = "https://github.com/ompweb-dev/ompweb/releases/download/ompweb-runner";

test("a channel manifest names this platform's runner", () => {
	const channel = parseRunnerChannel(JSON.stringify({ omp: "18.20.3-int.1", minHost: "0.7.2", assets: { [OMP_RUNNER_ASSET]: sha } }));
	assert.equal(channel.sha256, sha);
	assert.equal(runnerChannelSupported("0.7.2"), true);
	assert.equal(runnerChannelSupported("0.7.3"), false);
	assert.throws(() => parseRunnerChannel(JSON.stringify({ omp: "18.20.3", minHost: "0.7.2", assets: {} })), /lists no/);
});

test("install writes the checked runner and refuses a different hash", async () => {
	const target = join(dir, "ok", "ompweb-omp");
	globalThis.fetch = async (url) => String(url) === `${base}/${OMP_RUNNER_ASSET}` ? new Response(runner) : new Response("missing", { status: 404 });
	const channel = { omp: "18.20.3-int.1", minHost: "0.7.2", sha256: sha, asset: OMP_RUNNER_ASSET };
	assert.equal(await installRunnerChannel(channel, target, base), target);
	assert.deepEqual(readFileSync(target), runner);
	if (process.platform !== "win32") assert.equal(statSync(target).mode & 0o777, 0o755);
	const bad = join(dir, "bad", "ompweb-omp");
	await assert.rejects(installRunnerChannel({ ...channel, sha256: "a".repeat(64) }, bad, base), /SHA-256/);
	assert.equal(existsSync(bad), false);
});

test("an operator pin and an older host are not replaced", async () => {
	const previous = process.env.OMP_WEB_OMP_BIN;
	process.env.OMP_WEB_OMP_BIN = join(dir, "pinned");
	writeFileSync(process.env.OMP_WEB_OMP_BIN, "pin");
	const channel = { omp: "18.20.3-int.1", minHost: "0.7.2", sha256: sha, asset: OMP_RUNNER_ASSET };
	await assert.rejects(installRunnerChannel(channel, join(dir, "nope"), base), /OMP_WEB_OMP_BIN/);
	if (previous === undefined) delete process.env.OMP_WEB_OMP_BIN; else process.env.OMP_WEB_OMP_BIN = previous;
	await assert.rejects(installRunnerChannel({ ...channel, minHost: "9.9.9" }, join(dir, "old"), base), /older than minHost/);
});
