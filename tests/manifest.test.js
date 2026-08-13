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
  "_locales/en/messages.json",
  "_locales/zh_CN/messages.json",
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
  ...(process.env.PACKAGE_EXTENSION_DIR ? ["LICENSE", "NOTICE"] : []),
].sort();

test("manifest has the intentional minimum permission surface", async () => {
  const manifest = JSON.parse(await readFile(path.join(extension, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.1.3");
  assert.equal(manifest.default_locale, "en");
  assert.equal(manifest.name, "__MSG_extensionName__");
  assert.equal(manifest.description, "__MSG_extensionDescription__");
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

test("English and Simplified Chinese locales have the same complete key set", async () => {
  const en = JSON.parse(await readFile(
    path.join(extension, "_locales/en/messages.json"),
    "utf8",
  ));
  const zh = JSON.parse(await readFile(
    path.join(extension, "_locales/zh_CN/messages.json"),
    "utf8",
  ));
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  assert.equal(en.extensionName.message, "Let's GPC");
  assert.equal(zh.extensionName.message, "Let's GPC");

  const referenced = new Set();
  for (const file of ["manifest.json", "popup.html", "popup.js", "options.html", "options.js", "ui.js", "background.js"]) {
    const source = await readFile(path.join(extension, file), "utf8");
    for (const match of source.matchAll(/(?:__MSG_|\bmsg\(["']|data-i18n(?:-[a-z-]+)?=["'])([A-Za-z0-9_@]+)/g)) {
      const key = match[1].replace(/__$/, "");
      if (!key.startsWith("@@")) referenced.add(key);
    }
  }
  assert.deepEqual(
    [...referenced].filter((key) => !Object.hasOwn(en, key)),
    [],
    "all referenced messages must exist",
  );
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
