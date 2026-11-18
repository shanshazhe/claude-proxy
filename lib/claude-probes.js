const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

// Python 子进程只继承不会改变解释器行为的变量；新版 Windows Python Install Manager 默认可自动下载，必须显式禁止。
function pythonEnvironment(env = process.env, platform = process.platform) {
  const pythonEnv = { ...env };
  for (const name of ["BASH_ENV", "ENV", "NODE_OPTIONS"]) delete pythonEnv[name];
  for (const name of Object.keys(pythonEnv)) {
    if (/^(PYTHON|_PYTHON|PYLAUNCHER|PY_PYTHON|VIRTUAL_ENV|CONDA|LD_|DYLD_)/i.test(name)) delete pythonEnv[name];
  }
  if (platform === "win32") pythonEnv.PYTHON_MANAGER_AUTOMATIC_INSTALL = "false";
  return pythonEnv;
}

// 固定版本探测，不执行 shell 或浏览器提供的命令。
function createSetupProbe({ env = process.env, platform = process.platform, home = os.homedir(),
  node = process.execPath, execFileImpl = execFile, fsImpl = fs, includePython = false, includeClaudeCommand = false, cliOnly = false } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const directories = [...new Set([
    ...String(env.PATH || env.Path || "").split(platform === "win32" ? ";" : ":").filter((dir) => paths.isAbsolute(dir)).slice(0, 24),
    paths.join(home, ".local", "bin"), paths.join(home, ".npm-global", "bin"),
    ...(platform === "win32" ? [paths.join(env.APPDATA || paths.join(home, "AppData", "Roaming"), "npm"),
      paths.join(env.ProgramFiles || "C:\\Program Files", "Git", "bin"),
      paths.join(env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin"),
      paths.join(home, "scoop", "shims")] : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"])
  ])];
  const safeEnv = { ...env };
  for (const name of ["BASH_ENV", "ENV", "NODE_OPTIONS"]) delete safeEnv[name];
  const pythonEnv = pythonEnvironment(env, platform);
  const run = (file, args, childEnv = safeEnv) => new Promise((resolve) => {
    try {
      execFileImpl(file, args, { timeout: 1800, maxBuffer: 4096, windowsHide: true,
        shell: false, cwd: home, env: childEnv }, (error, stdout) => resolve(error ? "" : String(stdout)));
    } catch (_) { resolve(""); }
  });
  const exists = (file) => {
    try { return fsImpl.statSync(file).isFile(); } catch (_) { return false; }
  };
  async function find(name, accepts) {
    const candidates = directories.map((dir) => paths.join(dir, name + (platform === "win32" ? ".exe" : ""))).filter(exists);
    const results = await Promise.all(candidates.map(async (file) => accepts(await run(file, ["--version"])) ? file : null));
    return results.find(Boolean);
  }
  async function findPython() {
    const check = "import sys,json,hashlib,pathlib,argparse,re,tempfile,os,time,contextlib,typing; " +
      (platform === "win32" ? "import msvcrt; " : "import fcntl; ") +
      "print(json.dumps({'implementation':sys.implementation.name,'version':list(sys.version_info[:3])}))";
    const pythonDirectories = [...new Set([...directories, ...(platform === "win32" ? [
      paths.join(env.LOCALAPPDATA || paths.join(home, "AppData", "Local"), "Programs", "Python", "Launcher"),
      env.SystemRoot || "C:\\Windows"
    ].filter((directory) => paths.isAbsolute(directory)) : [])])];
    for (const name of platform === "win32" ? ["python3", "python", "py"] : ["python3", "python"]) {
      const candidates = pythonDirectories.map((directory) => paths.join(directory, name + (platform === "win32" ? ".exe" : ""))).filter(exists);
      const results = await Promise.all(candidates.map(async (file) => {
        const args = [...(name === "py" ? ["-3"] : []), "-I", "-B", "-c", check];
        try {
          const result = JSON.parse(await run(file, args, pythonEnv));
          const version = result.version;
          if (result.implementation === "cpython" && Array.isArray(version) && version.length === 3 &&
            version.every(Number.isInteger) && (version[0] > 3 || version[0] === 3 && version[1] >= 9)) {
            return { file, launcher: name === "py" };
          }
        } catch (_) { /* 固定结果，不暴露解释器输出。 */ }
        return null;
      }));
      if (results.some(Boolean)) return results.find(Boolean);
    }
    return null;
  }
  return async () => {
    const [nativeCli, bash, jq, nodeVersion] = await Promise.all([
      find("claude", (text) => /\b\d+\.\d+\.\d+\b.*Claude Code/i.test(text)),
      cliOnly ? null : find("bash", (text) => Number(text.match(/version\s+(\d+)\./i)?.[1]) >= 3),
      cliOnly ? null : find("jq", (text) => { const match = text.match(/jq-(\d+)\.(\d+)/); return match && (+match[1] > 1 || +match[1] === 1 && +match[2] >= 6); }),
      cliOnly ? "" : run(node, ["--version"])
    ]);
    let cli = nativeCli;
    let claudeCommand = cli ? { file: cli, args: [] } : null;
    // npm 在 Windows 上的 .cmd 不可经无 shell 的 execFile 启动；直接使用已知 cli.js。
    if (!cli) {
      const entries = directories.map((dir) => platform === "win32"
        ? paths.join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js")
        : paths.join(dir, "..", "lib", "node_modules", "@anthropic-ai", "claude-code", "cli.js")).filter(exists);
      const results = await Promise.all(entries.map(async (file) => /\b\d+\.\d+\.\d+\b.*Claude Code/i.test(await run(node, [file, "--version"])) ? file : null));
      cli = results.find(Boolean);
      if (cli) claudeCommand = { file: node, args: [cli] };
    }
    return { cli: Boolean(cli), bash, jq, node: Number(nodeVersion.match(/^v(\d+)\./)?.[1]) >= 18 ? node : null,
      ...(includeClaudeCommand ? { claudeCommand } : {}),
      ...(includePython ? { python: await findPython() } : {}) };
  };
}

module.exports = { createSetupProbe, pythonEnvironment };
