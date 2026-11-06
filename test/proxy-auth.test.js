const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

for (const platform of ["mac", "windows"]) {
  test(`${platform} proxy keeps auth before API CORS and limits startup settings sync to successful listen`, () => {
    const source = fs.readFileSync(path.resolve(platform, "proxy.js"), "utf8");
    assert.ok(source.indexOf("if (await authRouter(req, res)) return;") < source.indexOf("Access-Control-Allow-Origin"));
    assert.match(source, /credentialStore\.migrate\(/);
    assert.match(source, /getSettingsPaths\(\) \{ return \[getClaudeSettingsPath\(\)\]; \}/);
    assert.match(source, /if \(!isResponsesModel\(model\)\) \{ sendJsonError\(res, 400/);
    assert.match(source, /onCacheUsage/);
    assert.match(source, /createMacosService\(\{ proxyPath: __filename, port: PORT, onHandoff: shutdownProxy \}\)/);
    assert.match(source, /const authRouter = createAuthRouter\(\{[\s\S]*?macosService,/);
    assert.match(source, /const claudeSetup = createClaudeSetup\(\{ store: credentialStore, getAvailableModels, getGptModels, launcherInstaller: claudeLauncherInstaller \}\);/);
    assert.match(source, /setup: claudeSetup,/);
    assert.equal(source.split("claudeSetup.syncGptSubagentModel()").length, 2);
    assert.ok(source.indexOf("claudeSetup.syncGptSubagentModel()") > source.indexOf("server.listen(PORT"));
    assert.equal(source.split("claudeSetup.syncGptContextCapacity()").length, 3);
    assert.ok(source.lastIndexOf("claudeSetup.syncGptContextCapacity()") > source.indexOf("server.listen(PORT"));
    assert.match(source, /syncClaudeSettings\(\);/);
    assert.doesNotMatch(source, /macosService\.configure\(/);
    assert.match(source, /projectMemory: projectMemoryInstaller/);
    assert.match(source, /projectMemoryInstaller\.autoEnable\(\)/);
    assert.match(source, /const claudeLauncherInstaller = createClaudeLauncherInstaller\(\{ store: credentialStore \}\);/);
    assert.ok(source.indexOf("claudeLauncherInstaller.autoEnable()") > source.indexOf("server.listen(PORT"));
    assert.equal(source.split("claudeLauncherInstaller.autoEnable()").length, 2);
    assert.match(source, /complete: summaryModel\.complete/);
    assert.match(source, /server\.listen\(PORT, "127\.0\.0\.1"/);
  });
}
