import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extension = process.env.PACKAGE_EXTENSION_DIR
  ? path.resolve(process.env.PACKAGE_EXTENSION_DIR)
  : path.join(root, "extension");
const EXPECTED_RUNTIME_FILES = [
  "background.js",
  "base.css",
  "core.js",
  "gpc.js",
  "icons/icon-128.png",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "manifest.json",
  "options.css",
  "options.html",
  "options.js",
  "popup.css",
  "popup.html",
  "popup.js",
  "ui.js",
].sort();

test("manifest has the intentional minimum permission surface", async () => {
  const manifest = JSON.parse(await readFile(path.join(extension, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(Number(manifest.minimum_chrome_version), 145);
  assert.deepEqual(manifest.permissions.sort(), [
    "declarativeNetRequestWithHostAccess",
    "privacy",
    "scripting",
    "storage",
  ]);
  assert.deepEqual(manifest.host_permissions.sort(), [
    "http://*/*",
    "https://*/*",
    "ws://*/*",
    "wss://*/*",
  ]);
  assert.equal("content_scripts" in manifest, false);
  assert.equal("web_accessible_resources" in manifest, false);
  assert.equal(JSON.stringify(manifest).includes("<all_urls>"), false);
});

test("runtime package has no source maps, vendored libraries, or remote code", async () => {
  const files = await walk(extension);
  assert.deepEqual(files.sort(), EXPECTED_RUNTIME_FILES);
  const forbidden = files.filter((file) => /(?:\.map$|node_modules|vendor)/.test(file));
  assert.deepEqual(forbidden, []);

  let textBytes = 0;
  for (const file of files.filter((item) => /\.(?:css|html|js|json)$/.test(item))) {
    const source = await readFile(path.join(extension, file), "utf8");
    assert.equal(/<script[^>]+src=["']https?:/i.test(source), false, file);
    textBytes += Buffer.byteLength(source);
  }

  assert.ok(textBytes < 100_000, `text runtime is ${textBytes} bytes`);
});

async function walk(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path.join(directory, entry.name), relative));
    else if ((await stat(path.join(directory, entry.name))).isFile()) result.push(relative);
  }
  return result;
}
