"use strict";

const test = require("node:test");
if (process.platform === "win32") {
  test("Statusline", { skip: "Statusline tests are skipped on Windows" }, () => {});
  return;
}
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, execSync } = require("node:child_process");
const { createStatuslineInstaller } = require("../lib/statusline-install");

const bundleRoot = path.resolve(__dirname, "../");
function temp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function installerFor(configRoot, extra = {}) { return createStatuslineInstaller({ configRoot, bundleRoot, ...extra }); }
function remove(target) { fs.rmSync(target, { recursive: true, force: true }); }

test("synchronous deployment is idempotent, private, self-contained, and created-only cleanup", () => {
  const root = temp("statusline home 'quoted' ");
  try {
    const installer = installerFor(root);
    assert.equal(installer.validateBundle(), true);
    const first = installer.deploy({ bash: "/bin/bash", jq: "/usr/bin/jq" });
    assert.equal(first.created, true);
    assert.equal(installer.isConfigured({ type: "command", command: first.command }), true);
    const second = installer.deploy({ bash: "/bin/bash", jq: "/usr/bin/jq" });
    assert.equal(second.created, false);
    assert.equal(first.directory, second.directory);
    assert.equal(fs.statSync(first.directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(first.directory, "statusline-launcher.sh")).mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(first.directory).sort(), [".toolkit-generation", "statusline-command.sh", "statusline-launcher.sh"]);
    assert.equal(installer.cleanup(second), false);
    assert.equal(fs.existsSync(first.directory), true);
    assert.equal(installer.cleanup(first), true);
    assert.equal(installer.cleanup(first), true);
    assert.equal(fs.existsSync(first.directory), false);
  } finally { remove(root); }
});

const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

test("real launcher renders synthetic context, whole-session token/cache totals and cache state with the probed jq", () => {
  const root = temp("statusline synthetic 'quoted' ");
  const cwd = path.join(root, "project with spaces");
  const transcript = path.join(root, "transcript with spaces.jsonl");
  const marker = path.join(root, "jq-used");
  const jqWrapper = path.join(root, "probed jq");
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(jqWrapper, `#!/bin/bash\ntouch '${marker.replace(/'/g, "'\\''")}'\nexec /usr/bin/jq "$@"\n`, { mode: 0o700 });
  const usage = (output) => ({ input_tokens: 100, output_tokens: output, cache_read_input_tokens: 300, cache_creation_input_tokens: 100 });
  fs.writeFileSync(transcript, [
    { type: "user", message: { content: "synthetic only" } },
    { type: "assistant", requestId: "r1", message: { id: "m1", usage: usage(50) } },
    { type: "assistant", requestId: "r1", message: { id: "m1", usage: usage(80) } },
    { type: "assistant", isSidechain: true, requestId: "r2", message: { id: "m2", usage: usage(9000) } }
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  // Deploy from a relocated repository copy: the generation must not depend on the original checkout.
  const relocatedBundle = path.join(root, "repository-copy");
  fs.cpSync(path.join(bundleRoot, "statusline"), path.join(relocatedBundle, "statusline"), { recursive: true });
  const installer = installerFor(path.join(root, "claude config"), { bundleRoot: relocatedBundle });
  try {
    const deployment = installer.deploy({ bash: "/bin/bash", jq: jqWrapper });
    remove(relocatedBundle);
    const common = { cwd, model: { display_name: "Synthetic" }, context_window: { used_percentage: 25, context_window_size: 200000, current_usage: { input_tokens: 100, cache_read_input_tokens: 300, cache_creation_input_tokens: 100 } } };
    const invoke = (value) => strip(execSync(deployment.command, { input: JSON.stringify(value), cwd, encoding: "utf8", env: {
      PATH: "/usr/bin:/bin", HOME: root, USERPROFILE: root, LANG: "en_US.UTF-8"
    } }));
    const full = invoke({ ...common, transcript_path: transcript });
    assert.equal(full, "Synthetic | ctx: 500/200k (25%) | in: 0.5k out: 0.1k cache: 0.3k hit: 60%\n");
    assert.ok(fs.existsSync(marker));
    const empty = invoke({ cwd, model: { display_name: "Synthetic" } });
    assert.equal(empty, "Synthetic | in: n/a out: n/a cache: n/a hit: n/a\n");
    assert.equal(invoke({ ...common, effort: { level: "high" }, transcript_path: transcript }),
      full.replace("Synthetic", "Synthetic · effort: high"));
    for (const effort of [null, { level: "" }, { level: "unknown" }, "high"]) {
      assert.equal(invoke({ cwd, model: { display_name: "Synthetic" }, effort }), empty);
    }
    const state = (prompt_cache) => invoke({ cwd, model: { display_name: "Synthetic" }, prompt_cache }).replace(/^.*hit: n\/a/, "").trim();
    const warmCache = { caching_observed: true, warm: true, ttl: "5m", expires_at: 1000300, last_miss_at: 999000 };
    assert.equal(state(warmCache), "(warm)");
    assert.equal(state({ ...warmCache, warm: false, expires_at: null }), "(cold)");
    assert.equal(state({ ...warmCache, ttl: "1h", expires_at: 1003600, last_miss_at: 1000000, last_miss_cause: { causes: ["tools_changed"] } }), "(dropped: tools_changed)");
    assert.equal(state({ ...warmCache, caching_observed: false }), "");
    execFileSync("git", ["init", "--quiet", "--initial-branch=claude-hud", cwd]);
    assert.equal(invoke({ cwd, model: { display_name: "Synthetic" } }), `git:(claude-hud) | ${empty}`);
    const changedFile = path.join(cwd, "changed.txt");
    fs.writeFileSync(changedFile, "synthetic change\n");
    assert.equal(invoke({ cwd, model: { display_name: "Synthetic" } }), `git:(claude-hud)* | ${empty}`);
    installer.cleanup(deployment);
  } finally { remove(root); }
});

test("bundle validation rejects a missing script", () => {
  const root = temp("statusline graph ");
  try {
    assert.equal(installerFor(root).validateBundle(), true);
    assert.throws(() => installerFor(root, { bundleRoot: root }).validateBundle());
  } finally { remove(root); }
});

test("deployment rejects symlinked owned directories and failed staging leaves no generation", () => {
  const root = temp("statusline unsafe ");
  const outside = temp("statusline external ");
  try {
    const owned = path.join(root, "claude-proxy");
    fs.symlinkSync(outside, owned);
    assert.throws(() => installerFor(root).deploy(), /Unsafe statusline directory/);
  } finally { remove(root); remove(outside); }
  const failingRoot = temp("statusline failing ");
  try {
    const faultyFs = Object.create(fs);
    faultyFs.copyFileSync = () => { throw new Error("synthetic copy failure"); };
    assert.throws(() => installerFor(failingRoot, { fsImpl: faultyFs }).deploy(), /synthetic copy failure/);
    const installDir = path.join(failingRoot, "claude-proxy", "statusline");
    assert.deepEqual(fs.readdirSync(installDir), []);
  } finally { remove(failingRoot); }
});

test("reused generations verify script bytes and do not accept foreign or modified deployments", () => {
  const root = temp("statusline verify ");
  try {
    const installer = installerFor(root);
    const dependencies = { bash: "/bin/bash", jq: "/usr/bin/jq" };
    const installed = installer.deploy(dependencies);
    assert.equal(installer.isConfigured({ type: "command", command: installed.command.replace(root, "/foreign/root") }), false);
    const script = path.join(installed.directory, "statusline-command.sh");
    fs.appendFileSync(script, "\n# altered\n");
    assert.equal(installer.isConfigured({ type: "command", command: installed.command }), false);
    assert.throws(() => installer.deploy(dependencies), /failed verification/);
    assert.ok(fs.readFileSync(script, "utf8").endsWith("# altered\n"));
  } finally { remove(root); }
});

test("Windows command and launcher convert drive paths and quote spaces/apostrophes without settings env", () => {
  const root = temp("statusline windows ");
  try {
    const installer = installerFor(root, { platform: "win32" });
    const installed = installer.deploy({ bash: "C:\\Program Files\\Git\\bin\\bash.exe", jq: "C:\\Tool's folder\\jq.exe" });
    assert.match(installed.command, /^'\/c\/Program Files\/Git\/bin\/bash.exe'/);
    const launcher = fs.readFileSync(path.join(installed.directory, "statusline-launcher.sh"), "utf8");
    assert.ok(launcher.includes("export TOOLKIT_JQ='/c/Tool'\\''s folder/jq.exe'"));
    assert.doesNotMatch(launcher, /TOOLKIT_NODE/);
    assert.ok(launcher.includes("exec '/c/Program Files/Git/bin/bash.exe'"));
    assert.doesNotMatch(launcher, /CLAUDE_CONFIG_DIR/);
    execFileSync("bash", ["-n", path.join(installed.directory, "statusline-launcher.sh")]);
  } finally { remove(root); }
});

test("bundled script uses the probed jq adapter and has no personal paths", () => {
  const script = fs.readFileSync(path.join(bundleRoot, "statusline/statusline-command.sh"), "utf8");
  const adapter = 'jq() { "${TOOLKIT_JQ:-jq}" "$@"; }';
  assert.equal(script.split(adapter).length, 2);
  assert.doesNotMatch(script, /Users\/[^/]+|CLAUDE_CONFIG_DIR|node/);
  execFileSync("bash", ["-n", path.join(bundleRoot, "statusline/statusline-command.sh")]);
});
