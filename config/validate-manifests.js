const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const packageJson = readJson('package.json');
const chromeManifest = readJson('src/manifest.json');
const firefoxManifest = readJson('src/manifest.firefox.json');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

assert.equal(chromeManifest.manifest_version, 3);
assert.equal(chromeManifest.version, packageJson.version);
assert.equal(typeof chromeManifest.background.service_worker, 'string');
assert.equal(chromeManifest.background.scripts, undefined);
assert.equal(chromeManifest.developer, undefined);
assert.equal(chromeManifest.browser_specific_settings, undefined);

assert.equal(firefoxManifest.manifest_version, 3);
assert.equal(firefoxManifest.version, packageJson.version);
assert.ok(Array.isArray(firefoxManifest.background.scripts));
assert.equal(firefoxManifest.background.service_worker, undefined);
assert.equal(typeof firefoxManifest.browser_specific_settings.gecko.id, 'string');

console.log('Chrome and Firefox manifests are valid and browser-specific.');
