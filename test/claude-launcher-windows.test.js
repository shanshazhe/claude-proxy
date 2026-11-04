"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { createClaudeLauncherInstaller } = require("../lib/claude-launcher-install");
const { getStatus, setFeatures } = require("../lib/online-summary");

const START = "# >>> claude-proxy capacity launcher >>>";
const quote = (value) => "'" + value.replace(/'/g, "''") + "'";
const store = { readAuth: () => ({ openai: { type: "api_key", key: "test-key" } }) };
const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");

function fixture(t, options = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "launcher-windows-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const target = path.join(home, "Documents", "WindowsPowerShell", "profile.ps1");
  const configRoot = path.join(home, "config");
  const featureFile = path.join(home, "features.json");
  const calls = [];
  const execute = (file, args, settings) => {
    calls.push({ file, args });
    if (args.at(-1).includes?.("$PROFILE.CurrentUserAllHosts")) return target + "\r\n";
    if (process.platform === "win32") return execFileSync(file, args, settings);
    return process.version;
  };
  const installer = createClaudeLauncherInstaller({ home, configRoot, featureFile, platform: "win32",
    env: { ...process.env, SystemRoot: process.platform === "win32" ? process.env.SystemRoot : path.join(home, "Windows") },
    store, execFileSync: execute, ...options });
  const write = (bytes) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); };
  const backups = () => {
    const directory = path.join(configRoot, "claude-proxy/powershell-backups");
    return fs.existsSync(directory) ? fs.readdirSync(directory).map((file) => path.join(directory, file)) : [];
  };
  return { home, target, configRoot, featureFile, installer, calls, write, backups };
}

test("PowerShell installation preserves existing bytes, backs up once and is idempotent", async (t) => {
  const f = fixture(t);
  const original = Buffer.from("# existing profile\r\n$env:KEEP = 'yes'");
  f.write(original);
  assert.equal((await f.installer.autoEnable()).ok, true);
  const installed = fs.readFileSync(f.target);
  assert.deepEqual(installed.subarray(0, original.length), original);
  assert.match(installed.toString(), /function global:claude/);
  assert.match(installed.toString(), /Get-Command node\.exe -CommandType Application/);
  assert.match(installed.toString(), /claude-launch\.js'\) \+ \$args/);
  assert.equal(f.backups().length, 1);
  assert.deepEqual(fs.readFileSync(f.backups()[0]), original);
  const before = fs.statSync(f.target);
  const feature = fs.statSync(f.featureFile);
  const results = await Promise.all([f.installer.autoEnable(), f.installer.autoEnable()]);
  assert.ok(results.every((result) => result.ok && !result.changed));
  assert.equal(fs.statSync(f.target).mtimeMs, before.mtimeMs);
  assert.equal(fs.statSync(f.featureFile).mtimeMs, feature.mtimeMs);
  assert.equal(f.backups().length, 1);
  assert.ok(f.calls.some(({ args }) => args.includes("-NoProfile")));
});

test("missing PowerShell profile directories are created; exact block is adopted without backup", async (t) => {
  const f = fixture(t);
  assert.equal((await f.installer.autoEnable()).ok, true);
  assert.deepEqual([...fs.readFileSync(f.target).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(f.backups().length, 0);
  assert.equal((await f.installer.autoEnable()).changed, false);
  assert.equal(f.backups().length, 0);
  assert.equal(getStatus(f.featureFile).claudeLauncher, true);
});

test("PowerShell UTF-8 and UTF-16LE BOM profiles retain encoding and user code through disable", async (t) => {
  for (const encoding of ["utf8", "utf16le"]) {
    const f = fixture(t);
    const bom = encoding === "utf8" ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.from([0xff, 0xfe]);
    const original = Buffer.concat([bom, Buffer.from("# 用户配置\r\n$env:KEEP = 'yes'\r\n", encoding)]);
    f.write(original);
    assert.equal((await f.installer.autoEnable()).ok, true);
    assert.equal((await f.installer.autoEnable()).changed, false);
    fs.appendFileSync(f.target, Buffer.from("$env:LATER = 'keep'\r\n", encoding));
    setFeatures({ onlineSummary: false }, f.featureFile);
    assert.equal((await f.installer.configure(false)).ok, true);
    assert.deepEqual(fs.readFileSync(f.target), Buffer.concat([original, Buffer.from("$env:LATER = 'keep'\r\n", encoding)]));
    assert.equal(getStatus(f.featureFile).onlineSummary, false);
    assert.equal(getStatus(f.featureFile).claudeLauncher, false);
    assert.equal(await f.installer.autoEnable(), null);
    assert.equal((await f.installer.configure(true)).ok, true);
  }
});

test("only an exact stale PowerShell template is upgraded", async (t) => {
  const f = fixture(t, { repoRoot: path.resolve(os.tmpdir(), "old repo") });
  assert.equal((await f.installer.autoEnable()).ok, true);
  const installer = createClaudeLauncherInstaller({ home: f.home, configRoot: f.configRoot, featureFile: f.featureFile,
    platform: "win32", env: { ...process.env, SystemRoot: process.platform === "win32" ? process.env.SystemRoot : path.join(f.home, "Windows") },
    store, execFileSync(file, args, settings) {
      if (args.at(-1).includes?.("$PROFILE.CurrentUserAllHosts")) return f.target;
      return process.platform === "win32" ? execFileSync(file, args, settings) : process.version;
    } });
  assert.equal((await installer.autoEnable()).changed, true);
  assert.equal((await installer.autoEnable()).changed, false);
  assert.ok(fs.readFileSync(f.target, "utf8").includes(path.resolve(__dirname, "../lib/claude-launch.js")));
});

test("Windows missing GPT credentials and opt-out never probe or modify profiles", async (t) => {
  for (const auth of [{}, { "github-copilot": { type: "api_key", key: "test-only" } }]) {
    const installer = createClaudeLauncherInstaller({ platform: "win32", env: {}, store: { readAuth: () => auth },
      fsImpl: new Proxy({}, { get() { throw new Error("unexpected filesystem access"); } }),
      execFileSync() { throw new Error("unexpected PowerShell execution"); } });
    assert.equal(await installer.autoEnable(), null);
  }
  const f = fixture(t);
  setFeatures({ claudeLauncher: false }, f.featureFile);
  assert.equal(await f.installer.autoEnable(), null);
  assert.deepEqual(f.calls, []);
  assert.equal(fs.existsSync(f.target), false);
});

for (const content of ["function claude { 'user' }\r\n", "function global:claude { 'user' }\r\n",
  "Set-Alias -Name claude -Value other\r\n", "New-Alias claude other\r\n", "Set-Item function:claude { 'user' }\r\n",
  START + "\r\n", START + "\r\n" + START + "\r\n"]) {
  test("PowerShell conflict preserves profile: " + content.trim(), async (t) => {
    const f = fixture(t);
    f.write(content);
    const result = await f.installer.autoEnable();
    assert.equal(result.ok, false);
    assert.match(result.reason, /conflict|modified|marker/);
    assert.equal(fs.readFileSync(f.target, "utf8"), content);
    assert.equal(f.backups().length, 0);
  });
}

test("PowerShell edited managed blocks remain intact, including on persistent disable", async (t) => {
  const f = fixture(t);
  assert.equal((await f.installer.autoEnable()).ok, true);
  const modified = fs.readFileSync(f.target, "utf8").replace(") + $args", ") + 'custom'");
  f.write(modified);
  assert.equal((await f.installer.autoEnable()).ok, false);
  assert.equal((await f.installer.configure(false)).ok, false);
  assert.equal(getStatus(f.featureFile).claudeLauncher, false);
  assert.equal(fs.readFileSync(f.target, "utf8"), modified);
});

test("PowerShell disable persists opt-out even when profile discovery fails", async (t) => {
  const f = fixture(t);
  const installer = createClaudeLauncherInstaller({ home: f.home, configRoot: f.configRoot, featureFile: f.featureFile,
    platform: "win32", env: { SystemRoot: path.join(f.home, "Windows") }, store,
    execFileSync() { throw new Error("PowerShell unavailable"); } });
  assert.equal((await installer.configure(false)).ok, false);
  assert.equal(getStatus(f.featureFile).claudeLauncher, false);
  assert.equal(await installer.autoEnable(), null);
  assert.equal(fs.existsSync(f.target), false);
});

test("PowerShell concurrent edits and opt-out abort publication and clean temporary files", async (t) => {
  for (const optOut of [false, true]) {
    const f = fixture(t);
    f.write("# original\r\n");
    const installer = createClaudeLauncherInstaller({ home: f.home, configRoot: f.configRoot, featureFile: f.featureFile,
      platform: "win32", env: { SystemRoot: path.join(f.home, "Windows") }, store, execFileSync(file, args) {
        if (args.at(-1).includes?.("$PROFILE.CurrentUserAllHosts")) return f.target;
        if (args[0] === "--version") return process.version;
        if (optOut) setFeatures({ claudeLauncher: false }, f.featureFile);
        else f.write("# concurrent user edit\r\n");
      } });
    assert.equal((await installer.autoEnable()).ok, false);
    assert.equal(fs.readFileSync(f.target, "utf8"), optOut ? "# original\r\n" : "# concurrent user edit\r\n");
    if (optOut) assert.equal(getStatus(f.featureFile).claudeLauncher, false);
    assert.equal(fs.readdirSync(path.dirname(f.target)).some((name) => name.endsWith(".tmp")), false);
  }
});

test("PowerShell rejects directories, ambiguous non-ASCII encodings and unsafe backup bytes", async (t) => {
  for (const kind of ["directory", "encoding", "backup"]) {
    const f = fixture(t);
    if (kind === "directory") fs.mkdirSync(f.target, { recursive: true });
    else f.write(kind === "encoding" ? Buffer.from("# 用户配置\r\n") : "# original\r\n");
    if (kind === "backup") {
      const directory = path.join(f.configRoot, "claude-proxy/powershell-backups");
      fs.mkdirSync(directory, { recursive: true });
      const hash = require("crypto").createHash("sha256").update(fs.readFileSync(f.target)).digest("hex");
      fs.writeFileSync(path.join(directory, `profile-${hash}`), "corrupt backup");
    }
    const original = kind === "directory" ? null : fs.readFileSync(f.target);
    assert.equal((await f.installer.autoEnable()).ok, false);
    if (original) assert.deepEqual(fs.readFileSync(f.target), original);
    else assert.equal(fs.statSync(f.target).isDirectory(), true);
  }
});

test("PowerShell never follows a junction in the profile directory", { skip: process.platform !== "win32" }, async (t) => {
  const f = fixture(t);
  const destination = path.join(f.home, "other-directory");
  fs.mkdirSync(destination);
  fs.mkdirSync(path.dirname(path.dirname(f.target)), { recursive: true });
  fs.symlinkSync(destination, path.dirname(f.target), "junction");
  assert.equal((await f.installer.autoEnable()).ok, false);
  assert.deepEqual(fs.readdirSync(destination), []);
});

test("PowerShell syntax validation never executes existing profile code", { skip: process.platform !== "win32" }, async (t) => {
  const f = fixture(t);
  const marker = path.join(f.home, "must-not-run");
  const original = `New-Item -ItemType File ${quote(marker)}\r\nif (\r\n`;
  f.write(original);
  assert.equal((await f.installer.autoEnable()).ok, false);
  assert.equal(fs.readFileSync(f.target, "utf8"), original);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.readdirSync(path.dirname(f.target)).some((name) => name.endsWith(".tmp")), false);
});

test("PowerShell wrapper preserves cwd, arguments, Node fallback and native exit code", { skip: process.platform !== "win32" }, async (t) => {
  const f = fixture(t);
  const repoRoot = path.join(f.home, "repo ' 引号 spaces");
  fs.mkdirSync(path.join(repoRoot, "lib"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "lib/claude-launch.js"),
    'process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),input:require("fs").readFileSync(0,"utf8")})); process.stderr.write("fixture stderr"); process.exitCode=7;');
  const installer = createClaudeLauncherInstaller({ home: f.home, configRoot: f.configRoot, featureFile: f.featureFile,
    platform: "win32", env: process.env, store, repoRoot, execFileSync(file, args, settings) {
      if (args.at(-1).includes?.("$PROFILE.CurrentUserAllHosts")) return f.target;
      return execFileSync(file, args, settings);
    } });
  assert.equal((await installer.autoEnable()).ok, true);
  const args = ["--version", "space arg", "quote'arg", "", '{"mcpServers":{}}', 'space "quoted" arg', 'C:\\space dir\\',
    'slash\\"quote', 'two\\\\"quotes', 'plain\\', "line\nbreak", "& $HOME; Write-Error 'not code'"];
  for (const PATH of [path.dirname(process.execPath), path.join(f.home, "empty-path")]) {
    const command = `. ${quote(f.target)}; claude ${args.map(quote).join(" ")}; exit $LASTEXITCODE`;
    const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      { cwd: f.home, env: { ...process.env, PATH }, input: "fixture stdin", encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 7, result.stderr);
    assert.equal(result.stderr, "fixture stderr");
    assert.deepEqual(JSON.parse(result.stdout), { args, cwd: f.home, input: "fixture stdin" });
  }
});

test("PowerShell wrapper passes --version through to the installed official CLI", {
  skip: process.platform !== "win32" || process.env.RUN_CLAUDE_CLI_TESTS !== "1"
}, async (t) => {
  const f = fixture(t);
  const env = { ...process.env, HOME: f.home, USERPROFILE: f.home, CLAUDE_CONFIG_DIR: f.configRoot,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" };
  delete env.CLAUDECODE;
  const { claudeCommand } = await require("../lib/claude-probes").createSetupProbe({ env, includeClaudeCommand: true })();
  assert.ok(claudeCommand, "installed official CLI required for this opt-in test");
  // The temporary USERPROFILE intentionally removes the probe's real-home fallback.
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  const cliDirectory = claudeCommand.args.length ? path.resolve(path.dirname(claudeCommand.args[0]), "../../..") : path.dirname(claudeCommand.file);
  env[pathKey] = cliDirectory + path.delimiter + (env[pathKey] || "");
  const direct = spawnSync(claudeCommand.file, [...claudeCommand.args, "--version"], { env, encoding: "utf8", timeout: 15000 });
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal((await f.installer.configure(true)).ok, true);
  const wrapped = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
    `. ${quote(f.target)}; claude --version; exit $LASTEXITCODE`], { cwd: f.home, env, encoding: "utf8", timeout: 20000 });
  assert.equal(wrapped.status, 0, wrapped.stderr);
  assert.equal(wrapped.stdout, direct.stdout);
});
