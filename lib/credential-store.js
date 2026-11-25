const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PROVIDERS = ["openai", "openai-codex", "github-copilot", "nvidia"];
const storeError = () => new Error("无法安全读取或保存本地凭据；请检查凭据文件及权限。");

function savedNvidiaKeys(credential) {
  if (Array.isArray(credential?.keys)) return credential.keys.filter((entry) =>
    typeof entry?.id === "string" && /^[a-z0-9-]+$/.test(entry.id) && typeof entry.key === "string" && entry.key.trim());
  // The original single-key format remains readable until the next edit.
  if (credential?.type === "api_key" && typeof credential.key === "string" && credential.key.trim()) {
    return [{ id: "legacy", key: credential.key.trim() }];
  }
  return [];
}

// 只描述路径；加载模块不创建目录、不迁移凭据。
function createCredentialStore({ directory = path.join(os.homedir(), ".claude", "claude-proxy"), now = Date.now } = {}) {
  const authFile = path.join(directory, "auth.json");

  function ensureDirectory() {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(directory).isDirectory()) throw storeError();
    if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  }

  function readFile(file, privateTarget = false, readOnly = false) {
    try {
      if (!fs.lstatSync(file).isFile()) throw storeError();
      if (privateTarget) {
        if (!readOnly) {
          ensureDirectory();
          if (process.platform !== "win32") fs.chmodSync(file, 0o600);
        } else if (!fs.lstatSync(directory).isDirectory()) throw storeError();
      }
      const content = fs.readFileSync(file, "utf8");
      return content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw storeError();
    }
  }

  function readAuth({ readOnly = false } = {}) {
    const content = readFile(authFile, true, readOnly);
    if (content === undefined) return {};
    try {
      const data = JSON.parse(content);
      if (!data || typeof data !== "object" || Array.isArray(data)) throw storeError();
      return data;
    } catch (_) { throw storeError(); }
  }

  function atomicWrite(file, content, exclusive = false) {
    let temporary;
    try {
      ensureDirectory();
      if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) throw storeError();
      temporary = `${file}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
      // link 是不覆盖已有目标的原子创建；更新采用同目录 rename。
      if (exclusive) fs.linkSync(temporary, file);
      else fs.renameSync(temporary, file);
    } catch (_) { throw storeError(); }
    finally { if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }

  function updateProvider(provider, credential, expected) {
    if (!PROVIDERS.includes(provider)) throw storeError();
    const latest = readAuth();
    const current = latest[provider];
    if (expected && (!current || current.refresh !== expected.refresh || current.loginVersion !== expected.loginVersion)) return false;
    latest[provider] = expected ? { ...current, ...credential } : { ...credential };
    atomicWrite(authFile, JSON.stringify(latest, null, 2) + "\n");
    return true;
  }

  function saveLogin(provider, credential) {
    updateProvider(provider, { ...credential, loginAt: now(), loginVersion: crypto.randomUUID() });
  }

  // 显式外部来源只读导入；不查找或删除仓库内凭据。
  function migrate({ piAuthFile = process.env.PI_AUTH_FILE, onWarning = () => {} } = {}) {
    const sources = piAuthFile ? [path.resolve(piAuthFile)] : [];
    const warn = () => onWarning("旧凭据迁移未完成或存在冲突；保留原文件，请检查新存储目录。");
    function importFile(source, target, convert) {
      if (path.resolve(source) === path.resolve(target)) return;
      let original;
      try {
        original = readFile(source);
        if (original === undefined) return;
        // 即使目标损坏，也不把它当成空文件覆盖。
        if (fs.existsSync(target)) { warn(); return; }
        const { content, complete } = convert(original);
        atomicWrite(target, content, true);
        if (readFile(target) !== content) throw storeError();
        if (!complete) warn();
      } catch (_) { warn(); }
    }
    for (const source of sources) {
      importFile(source, authFile, (text) => {
        const data = JSON.parse(text);
        if (!data || typeof data !== "object" || Array.isArray(data)) throw storeError();
        const supported = Object.fromEntries(PROVIDERS.filter((provider) => validCredential(data[provider], provider))
          .map((provider) => [provider, data[provider]]));
        if (!Object.keys(supported).length) throw storeError();
        return { content: JSON.stringify(supported, null, 2) + "\n",
          complete: Object.keys(data).every((provider) => Object.hasOwn(supported, provider)) };
      });
    }
  }

  function updateNvidiaKeys(update) {
    const latest = readAuth();
    const keys = update(savedNvidiaKeys(latest.nvidia));
    if (!keys) return false;
    if (keys.length) latest.nvidia = { keys };
    else delete latest.nvidia;
    atomicWrite(authFile, JSON.stringify(latest, null, 2) + "\n");
    return true;
  }

  function saveNvidiaKey(key) {
    return updateNvidiaKeys((keys) => keys.some((entry) => entry.key === key)
      ? null : [...keys, { id: crypto.randomUUID(), key }]);
  }

  function removeNvidiaKey(id) {
    return updateNvidiaKeys((keys) => keys.some((entry) => entry.id === id) ? keys.filter((entry) => entry.id !== id) : null);
  }

  return { directory, authFile, readAuth, updateProvider, saveLogin, saveNvidiaKey, removeNvidiaKey, migrate };
}

const defaultStore = createCredentialStore();
module.exports = { createCredentialStore, defaultStore, savedNvidiaKeys };

function validCredential(value, provider) {
  if (provider === "nvidia") return savedNvidiaKeys(value).length > 0;
  if (value?.type === "api_key") return provider !== "github-copilot" && typeof value.key === "string" && Boolean(value.key);
  return value?.type === "oauth" && typeof value.access === "string" && Boolean(value.access) &&
    typeof value.refresh === "string" && Boolean(value.refresh) && Number.isFinite(value.expires);
}
