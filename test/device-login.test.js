const test = require("node:test");
const assert = require("node:assert/strict");
const { createDeviceLogin } = require("../lib/device-login");
const { COPILOT_HEADERS } = require("../lib/copilot-auth");

const BASE_TIME = 1_700_000_000_000;
const TERMINAL = new Set(["complete", "failed", "expired", "cancelled"]);

function response(data, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => data };
}

function makeJwt(accountId) {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId }
  })).toString("base64url");
  return `header.${payload}.signature`;
}

function harness({ fetchImpl, sleep, onCredentialsChanged, saveLogin } = {}) {
  let timestamp = BASE_TIME;
  const saved = [];
  const changed = [];
  const store = {
    saveLogin(provider, credential) {
      if (saveLogin) return saveLogin(provider, credential);
      saved.push({ provider, credential: { ...credential } });
    }
  };
  const service = createDeviceLogin({
    store,
    fetchImpl,
    now: () => timestamp,
    sleep,
    onCredentialsChanged: (provider) => {
      changed.push(provider);
      return onCredentialsChanged?.(provider);
    }
  });
  return {
    service, saved, changed,
    now: () => timestamp,
    advance: (milliseconds) => { timestamp += milliseconds; }
  };
}

async function terminalSnapshot(service, id) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const snapshot = service.get(id);
    if (snapshot && TERMINAL.has(snapshot.status)) return snapshot;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Login ${id} did not reach a terminal state`);
}

function getRequestBody(init) {
  return typeof init.body === "string" ? JSON.parse(init.body) : init.body;
}

test("ChatGPT device flow polls immediately, exchanges the code, and saves only the credential", async () => {
  const calls = [];
  const h = harness({ fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/usercode")) return response({ device_auth_id: "device-secret", user_code: "ABCD-EFGH", interval: 0 });
    if (url.endsWith("/deviceauth/token")) {
      assert.deepEqual(getRequestBody(init), { device_auth_id: "device-secret", user_code: "ABCD-EFGH" });
      return response({ authorization_code: "authorization-secret", code_verifier: "verifier-secret" });
    }
    assert.equal(url, "https://auth.openai.com/oauth/token");
    assert.equal(init.body.get("code"), "authorization-secret");
    assert.equal(init.body.get("code_verifier"), "verifier-secret");
    assert.equal(init.body.get("redirect_uri"), "https://auth.openai.com/deviceauth/callback");
    return response({ access_token: makeJwt("acct-123"), refresh_token: "refresh-secret", expires_in: 3600 });
  } });

  const initial = await h.service.start("chatgpt");
  assert.equal(initial.provider, "chatgpt");
  assert.equal(initial.status, "pending");
  assert.equal(initial.userCode, "ABCD-EFGH");
  assert.equal(initial.verificationUrl, "https://auth.openai.com/codex/device");
  assert.deepEqual(Object.keys(initial).sort(), ["id", "provider", "status", "userCode", "verificationUrl"]);
  const done = await terminalSnapshot(h.service, initial.id);
  assert.equal(done.status, "complete");
  assert.equal(calls.length, 3);
  assert.equal(calls[1].url, "https://auth.openai.com/api/accounts/deviceauth/token");
  assert.equal(h.saved.length, 1);
  assert.deepEqual(h.saved[0], {
    provider: "openai-codex",
    credential: {
      type: "oauth", access: makeJwt("acct-123"), refresh: "refresh-secret",
      expires: BASE_TIME + 3600000, accountId: "acct-123"
    }
  });
  assert.deepEqual(h.changed, ["openai-codex"]);
  assert.doesNotMatch(JSON.stringify(done), /device-secret|authorization-secret|verifier-secret|refresh-secret/);
});

test("ChatGPT login completes while post-login synchronization is pending and stays successful if it fails", async () => {
  let rejectSync;
  const h = harness({
    onCredentialsChanged: () => {
      assert.equal(h.saved.length, 1, "credentials must be saved before synchronization starts");
      return new Promise((_resolve, reject) => { rejectSync = reject; });
    },
    fetchImpl: async (url) => {
      if (url.endsWith("/usercode")) return response({ device_auth_id: "d", user_code: "CODE", interval: 0 });
      if (url.endsWith("/deviceauth/token")) return response({ authorization_code: "c", code_verifier: "v" });
      return response({ access_token: makeJwt("account"), refresh_token: "r", expires_in: 3600 });
    }
  });
  const started = await h.service.start("chatgpt");
  assert.equal((await terminalSnapshot(h.service, started.id)).status, "complete");
  assert.deepEqual(h.changed, ["openai-codex"]);
  rejectSync(new Error("private-capacity-discovery-error"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.service.get(started.id).status, "complete");
  assert.doesNotMatch(JSON.stringify(h.service.get(started.id)), /private-capacity/);
});

test("ChatGPT pending and slow_down responses honor the polling interval", async () => {
  let polls = 0;
  const delays = [];
  const h = harness({
    sleep: async (milliseconds) => { delays.push(milliseconds); },
    fetchImpl: async (url) => {
      if (url.endsWith("/usercode")) return response({ device_auth_id: "d", user_code: "CODE", interval: "2" });
      if (url.endsWith("/deviceauth/token")) {
        polls++;
        if (polls === 1) return response({ error: { code: "deviceauth_authorization_pending" } }, 403);
        if (polls === 2) return response({ error: "slow_down" }, 400);
        return response({ authorization_code: "c", code_verifier: "v" });
      }
      return response({ access_token: makeJwt("account"), refresh_token: "r", expires_in: 3600 });
    }
  });
  const started = await h.service.start("chatgpt");
  const done = await terminalSnapshot(h.service, started.id);
  assert.equal(done.status, "complete");
  assert.equal(polls, 3);
  assert.deepEqual(delays, [2000, 7000]);
});

test("ChatGPT uses default five seconds and handles generic authorization_pending", async () => {
  let polls = 0;
  const delays = [];
  const h = harness({ sleep: async (delay) => delays.push(delay), fetchImpl: async (url) => {
    if (url.endsWith("/usercode")) return response({ device_auth_id: "d", user_code: "CODE" });
    if (url.endsWith("/deviceauth/token")) {
      if (++polls === 1) return response({ error: "authorization_pending" }, 400);
      return response({ authorization_code: "code", code_verifier: "verifier" });
    }
    return response({ access_token: makeJwt("account"), refresh_token: "refresh", expires_in: 3600 });
  } });
  const started = await h.service.start("chatgpt");
  assert.equal((await terminalSnapshot(h.service, started.id)).status, "complete");
  assert.deepEqual(delays, [5000]);
});

test("expired Copilot exchange tokens do not replace a working credential", async () => {
  const h = harness({ sleep: async () => {}, fetchImpl: async (url) => {
    if (url.endsWith("/device/code")) return response({ device_code: "d", user_code: "CODE", verification_uri: "https://github.com/login/device", expires_in: 900 });
    if (url.endsWith("/login/oauth/access_token")) return response({ access_token: "private-github" });
    return response({ token: "private-expired", expires_at: BASE_TIME / 1000 - 1 });
  } });
  const started = await h.service.start("copilot");
  const done = await terminalSnapshot(h.service, started.id);
  assert.equal(done.status, "failed");
  assert.equal(h.saved.length, 0);
  assert.doesNotMatch(JSON.stringify(done), /private/);
});

test("Copilot waits before polling, honors pending and slow_down, and applies the five-minute skew", async () => {
  let polls = 0;
  const delays = [];
  const h = harness({
    sleep: async (milliseconds) => { delays.push(milliseconds); },
    fetchImpl: async (url, init) => {
      if (url === "https://github.com/login/device/code") {
        assert.equal(init.body.get("client_id"), "Iv1.b507a08c87ecfe98");
        return response({
          device_code: "device-secret", user_code: "WXYZ-9876", verification_uri: "https://github.com/login/device?user_code=private",
          interval: 2, expires_in: 900
        });
      }
      if (url === "https://github.com/login/oauth/access_token") {
        polls++;
        if (polls === 1) return response({ error: "authorization_pending" });
        if (polls === 2) return response({ error: "slow_down" });
        assert.equal(init.body.get("device_code"), "device-secret");
        return response({ access_token: "oauth-secret" });
      }
      assert.equal(url, "https://api.github.com/copilot_internal/v2/token");
      assert.equal(init.headers.Authorization, "Bearer oauth-secret");
      for (const [key, value] of Object.entries(COPILOT_HEADERS)) assert.equal(init.headers[key], value);
      return response({ token: "copilot-secret", expires_at: BASE_TIME / 1000 + 3600 });
    }
  });
  const started = await h.service.start("copilot");
  assert.equal(started.verificationUrl, "https://github.com/login/device");
  const done = await terminalSnapshot(h.service, started.id);
  assert.equal(done.status, "complete");
  assert.equal(polls, 3);
  assert.deepEqual(delays, [2000, 2000, 7000]);
  assert.deepEqual(h.saved[0], {
    provider: "github-copilot",
    credential: { type: "oauth", access: "copilot-secret", refresh: "oauth-secret", expires: BASE_TIME + 3300000 }
  });
  assert.deepEqual(h.changed, ["github-copilot"]);
  assert.doesNotMatch(JSON.stringify(done), /device-secret|oauth-secret|copilot-secret|private/);
});

test("denied authorization is terminal and does not save credentials", async (t) => {
  for (const provider of ["chatgpt", "copilot"]) {
    await t.test(provider, async () => {
      const h = harness({
        sleep: async () => {},
        fetchImpl: async (url) => {
          if (url.endsWith("/usercode")) return response({ device_auth_id: "secret", user_code: "CODE", interval: 1 });
          if (url.endsWith("/device/code")) return response({
            device_code: "secret", user_code: "CODE", verification_uri: "https://github.com/login/device", interval: 1, expires_in: 30
          });
          if (url.endsWith("/deviceauth/token") || url.endsWith("/login/oauth/access_token")) {
            return response({ error: "access_denied", error_description: "upstream private details" }, 400);
          }
          throw new Error("unexpected request");
        }
      });
      const started = await h.service.start(provider);
      const done = await terminalSnapshot(h.service, started.id);
      assert.equal(done.status, "failed");
      assert.equal(done.error, "Login was denied");
      assert.equal(h.saved.length, 0);
      assert.doesNotMatch(JSON.stringify(done), /secret|private details|access_denied/);
    });
  }
});

test("ChatGPT flow expires at its injected 15-minute deadline", async () => {
  let h;
  h = harness({
    sleep: async () => { h.advance(15 * 60 * 1000); },
    fetchImpl: async (url) => {
      if (url.endsWith("/usercode")) return response({ device_auth_id: "d", user_code: "CODE", interval: 1 });
      if (url.endsWith("/deviceauth/token")) return response({ error: "deviceauth_authorization_pending" }, 403);
      throw new Error("token exchange must not be attempted after expiry");
    }
  });
  const started = await h.service.start("chatgpt");
  const done = await terminalSnapshot(h.service, started.id);
  assert.equal(done.status, "expired");
  assert.equal(done.error, "Device login expired");
  assert.equal(h.saved.length, 0);
});

test("Copilot device-code expiration is honored", async () => {
  let h;
  h = harness({
    sleep: async (milliseconds) => { h.advance(milliseconds); },
    fetchImpl: async (url) => {
      if (url.endsWith("/device/code")) return response({
        device_code: "d", user_code: "CODE", verification_uri: "https://github.com/login/device", interval: 1, expires_in: 1
      });
      throw new Error("polling must not begin after expiration");
    }
  });
  const started = await h.service.start("copilot");
  const done = await terminalSnapshot(h.service, started.id);
  assert.equal(done.status, "expired");
  assert.equal(h.saved.length, 0);
});

test("token exchange failures and malformed ChatGPT JWTs return only sanitized errors", async (t) => {
  await t.test("OpenAI exchange HTTP error", async () => {
    const h = harness({ fetchImpl: async (url) => {
      if (url.endsWith("/usercode")) return response({ device_auth_id: "d", user_code: "CODE", interval: 1 });
      if (url.endsWith("/deviceauth/token")) return response({ authorization_code: "c", code_verifier: "v" });
      return response({ error: "UPSTREAM-SECRET", access_token: "BODY-SECRET" }, 500);
    } });
    const started = await h.service.start("chatgpt");
    const done = await terminalSnapshot(h.service, started.id);
    assert.equal(done.status, "failed");
    assert.equal(done.error, "Unable to exchange login code");
    assert.equal(h.saved.length, 0);
    assert.doesNotMatch(JSON.stringify(done), /UPSTREAM-SECRET|BODY-SECRET/);
  });

  await t.test("Copilot exchange HTTP error", async () => {
    const h = harness({
      sleep: async () => {},
      fetchImpl: async (url) => {
        if (url.endsWith("/device/code")) return response({
          device_code: "d", user_code: "CODE", verification_uri: "https://github.com/login/device", interval: 1, expires_in: 90
        });
        if (url.endsWith("/login/oauth/access_token")) return response({ access_token: "oauth-secret" });
        return response({ message: "UPSTREAM-SECRET", token: "BODY-SECRET" }, 503);
      }
    });
    const started = await h.service.start("copilot");
    const done = await terminalSnapshot(h.service, started.id);
    assert.equal(done.status, "failed");
    assert.equal(done.error, "Unable to finish Copilot login");
    assert.equal(h.saved.length, 0);
    assert.doesNotMatch(JSON.stringify(done), /oauth-secret|UPSTREAM-SECRET|BODY-SECRET/);
  });

  await t.test("JWT without accountId", async () => {
    const h = harness({ fetchImpl: async (url) => {
      if (url.endsWith("/usercode")) return response({ device_auth_id: "d", user_code: "CODE", interval: 1 });
      if (url.endsWith("/deviceauth/token")) return response({ authorization_code: "c", code_verifier: "v" });
      return response({ access_token: "not-a-jwt", refresh_token: "private-refresh", expires_in: 3600 });
    } });
    const started = await h.service.start("chatgpt");
    const done = await terminalSnapshot(h.service, started.id);
    assert.equal(done.status, "failed");
    assert.equal(done.error, "Unable to exchange login code");
    assert.equal(h.saved.length, 0);
  });
});

test("a per-request timeout aborts the fetch and never exposes its rejection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let aborted = false;
  const h = harness({ fetchImpl: async (_url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      aborted = true;
      reject(new Error("UPSTREAM-TIMEOUT-SECRET"));
    }, { once: true });
  }) });
  const started = h.service.start("chatgpt");
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(10000);
  const snapshot = await started;
  assert.equal(aborted, true);
  assert.equal(snapshot.status, "failed");
  assert.equal(snapshot.error, "Login request timed out");
  assert.doesNotMatch(JSON.stringify(snapshot), /UPSTREAM-TIMEOUT-SECRET/);
});

test("repeated starts reuse one active provider flow and close cancels it", async () => {
  let resolveDevice;
  let userCodeCalls = 0;
  const h = harness({
    sleep: () => new Promise(() => {}),
    fetchImpl: async (url) => {
      if (url.endsWith("/usercode")) {
        userCodeCalls++;
        return new Promise((resolve) => { resolveDevice = resolve; });
      }
      return response({ error: "deviceauth_authorization_pending" }, 403);
    }
  });
  const firstPromise = h.service.start("chatgpt");
  const secondPromise = h.service.start("chatgpt");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(userCodeCalls, 1);
  resolveDevice(response({ device_auth_id: "private-device", user_code: "CODE", interval: 1 }));
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(first.id, second.id);
  const repeated = await h.service.start("chatgpt");
  assert.equal(repeated.id, first.id);
  assert.equal(userCodeCalls, 1);
  h.service.close();
  assert.equal(h.service.get(first.id).status, "cancelled");
  await assert.rejects(h.service.start("chatgpt"), /service is closed/);
});

test("Copilot rejects non-official verification links and sanitizes upstream errors", async () => {
  const h = harness({ fetchImpl: async () => response({
    device_code: "device-secret", user_code: "CODE", verification_uri: "http://evil.example/login/device?token=secret",
    interval: 5, expires_in: 600, error_description: "upstream response secret"
  }) });
  const snapshot = await h.service.start("copilot");
  assert.equal(snapshot.status, "failed");
  assert.equal(snapshot.error, "Unable to start login");
  assert.equal(snapshot.userCode, undefined);
  assert.doesNotMatch(JSON.stringify(snapshot), /device-secret|evil|secret/);
});

test("terminal snapshots expire and remain bounded", async () => {
  const h = harness({ fetchImpl: async () => response({ error: "upstream secret" }, 500) });
  let firstId;
  let lastId;
  for (let index = 0; index < 33; index++) {
    const snapshot = await h.service.start("chatgpt");
    if (index === 0) firstId = snapshot.id;
    lastId = snapshot.id;
  }
  assert.equal(h.service.get(firstId), undefined);
  assert.equal(h.service.get(lastId).status, "failed");
  h.advance(30 * 60 * 1000);
  assert.equal(h.service.get(lastId), undefined);
});
