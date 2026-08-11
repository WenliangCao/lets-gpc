import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = path.join(root, "extension");
const chromeBinary = process.env.CHROME_BINARY || (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : null);

test("Chrome sends Sec-GPC and exposes the page API with working exceptions", {
  timeout: 30_000,
}, async (context) => {
  if (!chromeBinary) {
    context.skip("Set CHROME_BINARY to run the real-browser integration test");
    return;
  }

  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({
      url: request.url,
      headers: request.headers,
      rawHeaders: request.rawHeaders,
    });

    if (request.url === "/.well-known/gpc.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"gpc":true,"lastUpdate":"2026-08-10"}');
      return;
    }

    if (request.url?.startsWith("/pixel")) {
      response.writeHead(204);
      response.end();
      return;
    }

    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    const resourceHost = request.url === "/excluded"
      ? "localhost"
      : request.url === "/recipient"
        ? "127.0.0.1"
        : null;
    const resourceUrl = resourceHost
      ? `http://${resourceHost}:${server.address().port}/pixel?${Date.now()}`
      : `/pixel?${Date.now()}`;
    const socketProbe = request.url === "/enabled"
      ? `<script>new WebSocket("ws://127.0.0.1:${server.address().port}/socket")</script>`
      : "";
    const workerProbe = request.url === "/enabled"
      ? `<script>
          const worker = new Worker(URL.createObjectURL(new Blob([
            'postMessage(typeof navigator.globalPrivacyControl); fetch("http://127.0.0.1:${server.address().port}/worker-fetch")'
          ], { type: "text/javascript" })));
          worker.onmessage = (event) => { window.workerGpcType = event.data; };
        </script>`
      : "";
    response.end(`<!doctype html>
      <meta charset="utf-8">
      <script>
        window.inlineGpc = {
          value: navigator.globalPrivacyControl,
          type: typeof navigator.globalPrivacyControl
        };
      </script>
      <img src="${resourceUrl}" alt="">
      ${socketProbe}
      ${workerProbe}`);
  });
  server.on("upgrade", (request, socket) => {
    requests.push({
      url: request.url,
      headers: request.headers,
      rawHeaders: request.rawHeaders,
    });
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.end([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "::", resolve);
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const redirectRequests = [];
  const redirectServer = http.createServer((request, response) => {
    redirectRequests.push({ url: request.url, headers: request.headers });
    if (request.url === "/.well-known/gpc.json") {
      response.writeHead(302, {
        location: `${origin}/redirected-gpc.json`,
      });
      response.end();
      return;
    }

    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(`<!doctype html><script>
      window.inlineGpc = {
        value: navigator.globalPrivacyControl,
        type: typeof navigator.globalPrivacyControl
      };
    </script>`);
  });
  await new Promise((resolve, reject) => {
    redirectServer.once("error", reject);
    redirectServer.listen(0, "::", resolve);
  });
  const redirectOrigin = `http://localhost:${redirectServer.address().port}`;
  const profile = await mkdtemp(path.join(os.tmpdir(), "lets-gpc-chrome-"));
  const chrome = spawn(chromeBinary, [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--enable-unsafe-extension-debugging",
    "--headless=new",
    "--remote-debugging-pipe",
    `--user-data-dir=${profile}`,
    "--window-size=800,600",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const browser = new PipeCdp(chrome.stdio[3], chrome.stdio[4]);

  try {
    await browser.send("Browser.getVersion");
    const { id: extensionId } = await browser.send("Extensions.loadUnpacked", {
      path: extensionPath,
    });

    const workerTarget = await waitFor(async () => {
      const { targetInfos } = await browser.send("Target.getTargets");
      return targetInfos.find((target) =>
        target.type === "service_worker"
        && target.url === `chrome-extension://${extensionId}/background.js`);
    }, 10_000, "extension service worker");
    const worker = await browser.attach(workerTarget.targetId);

    await waitFor(async () => {
      const value = await worker.evaluate(`Promise.all([
        chrome.declarativeNetRequest.getDynamicRules(),
        chrome.scripting.getRegisteredContentScripts(),
        chrome.privacy.websites.topicsEnabled.get({})
      ]).then(([rules, scripts, topics]) => ({
        rules: rules.length,
        scripts: scripts.length,
        topics: topics.value
      }))`);
      return value.rules === 1 && value.scripts === 1 && value.topics === false
        ? value
        : null;
    }, 10_000, "extension initialization");

    requests.length = 0;
    const enabledPage = await openPage(browser, `${origin}/enabled`);
    try {
      const inline = await waitFor(
        () => enabledPage.evaluate("window.inlineGpc || null"),
        5_000,
        "enabled page inline signal",
      );
      assert.deepEqual(inline, { value: true, type: "boolean" });
      await waitFor(
        () => requests.find((request) => request.url === "/enabled"),
        5_000,
        "enabled request",
      );
      assert.equal(
        requests.find((request) => request.url === "/enabled").headers["sec-gpc"],
        "1",
      );
      const enabledPixel = requests.find((request) => request.url.startsWith("/pixel"));
      assert.equal(enabledPixel.headers["sec-gpc"], "1");
      assert.deepEqual(headerValues(enabledPixel.rawHeaders, "sec-gpc"), ["1"]);
      const socketRequest = await waitFor(
        () => requests.find((request) => request.url === "/socket"),
        5_000,
        "WebSocket handshake",
      );
      assert.deepEqual(headerValues(socketRequest.rawHeaders, "sec-gpc"), ["1"]);
      const workerRequest = await waitFor(
        () => requests.find((request) => request.url === "/worker-fetch"),
        5_000,
        "Worker fetch",
      );
      assert.deepEqual(headerValues(workerRequest.rawHeaders, "sec-gpc"), ["1"]);
      assert.equal(await waitFor(
        () => enabledPage.evaluate("window.workerGpcType || null"),
        5_000,
        "WorkerNavigator limitation result",
      ), "undefined");

      await browser.send("Target.activateTarget", { targetId: enabledPage.targetId });
      const popup = await openPage(
        browser,
        `chrome-extension://${extensionId}/popup.html`,
        { background: true },
      );
      try {
        const popupState = await waitFor(async () => {
          const value = await popup.evaluate(`({
            domain: document.querySelector("#domain").textContent,
            error: document.querySelector("#error").hidden,
            global: document.querySelector("#global-toggle").checked,
            site: document.querySelector("#site-toggle").checked,
            header: document.querySelector("#header-status").textContent,
            dom: document.querySelector("#dom-status").textContent,
            support: document.querySelector("#support-status").textContent
          })`);
          return value.domain === "127.0.0.1"
            && value.support === "声明支持 GPC"
            ? value
            : null;
        }, 5_000, "popup state");
        assert.deepEqual(popupState, {
          domain: "127.0.0.1",
          error: true,
          global: true,
          site: true,
          header: "发送 1",
          dom: "true",
          support: "声明支持 GPC",
        });
        await captureUi(popup, "popup.png");

        await popup.evaluate("document.querySelector('#site-toggle').click()");
        const toggled = await waitFor(async () => {
          const value = await popup.evaluate(`({
            site: document.querySelector("#site-toggle").checked,
            reload: document.querySelector("#reload").hidden,
            error: document.querySelector("#error").hidden
          })`);
          return !value.site && !value.reload ? value : null;
        }, 5_000, "popup site toggle");
        assert.deepEqual(toggled, { site: false, reload: false, error: true });
      } finally {
        await popup.close();
      }
    } finally {
      await enabledPage.close();
    }

    const options = await openPage(
      browser,
      `chrome-extension://${extensionId}/options.html`,
    );
    try {
      await waitFor(
        () => options.evaluate("document.querySelector('#global-toggle').checked"),
        5_000,
        "options state",
      );
      await captureUi(options, "options.png");
      const exceptionChecked = await options.evaluate(
        "document.querySelector('input[data-host=\"127.0.0.1\"]')?.checked",
      );
      assert.equal(exceptionChecked, false);
    } finally {
      await options.close();
    }

    const rule = await worker.evaluate(
      "chrome.declarativeNetRequest.getDynamicRules().then(([rule]) => rule)",
    );
    assert.equal("excludedRequestDomains" in rule.condition, false);
    assert.deepEqual(rule.condition.excludedTopDomains, ["127.0.0.1"]);

    requests.length = 0;
    redirectRequests.length = 0;
    const redirectPage = await openPage(browser, `${redirectOrigin}/redirect-check`);
    try {
      await browser.send("Target.activateTarget", { targetId: redirectPage.targetId });
      const redirectPopup = await openPage(
        browser,
        `chrome-extension://${extensionId}/popup.html`,
        { background: true },
      );
      try {
        const support = await waitFor(async () => {
          const value = await redirectPopup.evaluate(
            "document.querySelector('#support-status').textContent",
          );
          return value === "未提供有效声明" ? value : null;
        }, 5_000, "redirecting support resource rejection");
        assert.equal(support, "未提供有效声明");
        assert.equal(
          redirectRequests.some((request) => request.url === "/.well-known/gpc.json"),
          true,
        );
        assert.equal(
          requests.some((request) => request.url === "/redirected-gpc.json"),
          false,
        );
      } finally {
        await redirectPopup.close();
      }
    } finally {
      await redirectPage.close();
    }

    requests.length = 0;
    const recipientPage = await openPage(
      browser,
      `http://localhost:${address.port}/recipient`,
    );
    try {
      const inline = await waitFor(
        () => recipientPage.evaluate("window.inlineGpc || null"),
        5_000,
        "non-exempt page inline signal",
      );
      assert.deepEqual(inline, { value: true, type: "boolean" });
      const pageRequest = requests.find((request) => request.url === "/recipient");
      const recipientRequest = await waitFor(
        () => requests.find((request) =>
          request.url.startsWith("/pixel")
          && request.headers.host === `127.0.0.1:${address.port}`),
        5_000,
        "non-exempt page subresource",
      );
      assert.equal(pageRequest.headers["sec-gpc"], "1");
      assert.equal(recipientRequest.headers["sec-gpc"], "1");
    } finally {
      await recipientPage.close();
    }

    requests.length = 0;
    const excludedPage = await openPage(browser, `${origin}/excluded`);
    try {
      const inline = await waitFor(
        () => excludedPage.evaluate("window.inlineGpc || null"),
        5_000,
        "excluded page inline signal",
      );
      assert.equal(inline.value, undefined);
      assert.equal(inline.type, "undefined");
      await waitFor(
        () => requests.find((request) => request.url === "/excluded"),
        5_000,
        "excluded request",
      );
      assert.equal(
        requests.find((request) => request.url === "/excluded").headers["sec-gpc"],
        undefined,
      );
      const excludedChild = await waitFor(
        () => requests.find((request) =>
          request.url.startsWith("/pixel")
          && request.headers.host === `localhost:${address.port}`),
        5_000,
        "top-level-exception subresource",
      );
      assert.equal(excludedChild.headers["sec-gpc"], undefined);
    } finally {
      await excludedPage.close();
    }

    const optionsAgain = await openPage(
      browser,
      `chrome-extension://${extensionId}/options.html`,
    );
    try {
      const restored = await optionsAgain.evaluate(`chrome.runtime.sendMessage({
        type: "set-host",
        host: "127.0.0.1",
        enabled: true
      })`);
      assert.equal(restored.ok, true, restored.error);

      const registered = await worker.evaluate(
        "chrome.scripting.getRegisteredContentScripts().then(([script]) => script)",
      );
      assert.deepEqual(registered.excludeMatches ?? [], []);

      requests.length = 0;
      const restoredPage = await openPage(browser, `${origin}/restored`);
      try {
        const inline = await waitFor(
          () => restoredPage.evaluate("window.inlineGpc || null"),
          5_000,
          "restored page inline signal",
        );
        assert.deepEqual(inline, { value: true, type: "boolean" });
        const restoredRequest = requests.find((request) => request.url === "/restored");
        assert.equal(restoredRequest.headers["sec-gpc"], "1");
      } finally {
        await restoredPage.close();
      }

      const disabledLocalhost = await optionsAgain.evaluate(`chrome.runtime.sendMessage({
        type: "set-host",
        host: "localhost",
        enabled: false
      })`);
      assert.equal(disabledLocalhost.ok, true, disabledLocalhost.error);

      requests.length = 0;
      const inheritedException = await openPage(
        browser,
        `http://foo.localhost:${address.port}/inherited-exception`,
      );
      try {
        const inline = await waitFor(
          () => inheritedException.evaluate("window.inlineGpc || null"),
          5_000,
          "localhost subdomain exception",
        );
        assert.equal(inline.type, "undefined");
        const inheritedRequest = requests.find(
          (request) => request.url === "/inherited-exception",
        );
        assert.equal(inheritedRequest.headers["sec-gpc"], undefined);
      } finally {
        await inheritedException.close();
      }

      const enabledChild = await optionsAgain.evaluate(`chrome.runtime.sendMessage({
        type: "set-host",
        host: "foo.localhost",
        enabled: true
      })`);
      assert.equal(enabledChild.ok, false);
      assert.match(enabledChild.error, /localhost/);

      const enabledParent = await optionsAgain.evaluate(`chrome.runtime.sendMessage({
        type: "set-host",
        host: "localhost",
        enabled: true
      })`);
      assert.equal(enabledParent.ok, true, enabledParent.error);

      requests.length = 0;
      const restoredChild = await openPage(
        browser,
        `http://foo.localhost:${address.port}/restored-child`,
      );
      try {
        const inline = await waitFor(
          () => restoredChild.evaluate("window.inlineGpc || null"),
          5_000,
          "restored localhost subdomain",
        );
        assert.deepEqual(inline, { value: true, type: "boolean" });
        const restoredChildRequest = requests.find(
          (request) => request.url === "/restored-child",
        );
        assert.equal(restoredChildRequest.headers["sec-gpc"], "1");
      } finally {
        await restoredChild.close();
      }

      requests.length = 0;
      const ipv6Url = `http://[::1]:${address.port}/ipv6`;
      const ipv6Page = await openPage(browser, ipv6Url);
      try {
        const inline = await waitFor(
          () => ipv6Page.evaluate("window.inlineGpc || null"),
          5_000,
          "IPv6 page inline signal",
        );
        assert.deepEqual(inline, { value: true, type: "boolean" });
        const ipv6Request = await waitFor(
          () => requests.find((request) => request.url === "/ipv6"),
          5_000,
          "IPv6 request",
        );
        assert.equal(ipv6Request.headers["sec-gpc"], "1");

        const ipv6State = await optionsAgain.evaluate(`chrome.runtime.sendMessage({
          type: "get-state",
          url: ${JSON.stringify(ipv6Url)}
        }).then((response) => response.value)`);
        assert.equal(ipv6State.host, "[::1]");
        assert.equal(ipv6State.hostAccess, true);
        assert.equal(ipv6State.hostEnabled, true);
        assert.equal(ipv6State.exceptionSupported, false);

        await browser.send("Target.activateTarget", { targetId: ipv6Page.targetId });
        const ipv6Popup = await openPage(
          browser,
          `chrome-extension://${extensionId}/popup.html`,
          { background: true },
        );
        try {
          const popupState = await waitFor(async () => {
            const value = await ipv6Popup.evaluate(`({
              domain: document.querySelector("#domain").textContent,
              checked: document.querySelector("#site-toggle").checked,
              disabled: document.querySelector("#site-toggle").disabled,
              detail: document.querySelector("#site-detail").textContent,
              dom: document.querySelector("#dom-status").textContent
            })`);
            return value.domain === "[::1]" ? value : null;
          }, 5_000, "IPv6 popup state");
          assert.equal(popupState.checked, true);
          assert.equal(popupState.disabled, true);
          assert.match(popupState.detail, /不支持此地址类型/);
          assert.equal(popupState.dom, "true");
        } finally {
          await ipv6Popup.close();
        }
      } finally {
        await ipv6Page.close();
      }

      const freshExport = await optionsAgain.evaluate(`Promise.all([
        chrome.runtime.sendMessage({
          type: "record-hosts",
          hosts: ["export-fresh.example"]
        }),
        chrome.runtime.sendMessage({ type: "get-export-data" })
      ]).then((responses) => responses[1])`);
      assert.equal(freshExport.ok, true, freshExport.error);
      assert.equal(
        freshExport.value.domains.some(({ host }) => host === "export-fresh.example"),
        true,
      );

      const importResponse = await optionsAgain.evaluate(`chrome.runtime.sendMessage({
        type: "import-data",
        data: {
          format: "lets-gpc",
          version: 1,
          settings: {
            enabled: true,
            blockTopics: true,
            theme: "system",
            disabledHosts: []
          },
          domains: Array.from({ length: 600 }, (_, index) => ({
            host: \`domain-\${index}.example\`,
            lastSeen: index,
            flags: 1
          }))
        }
      })`);
      assert.equal(importResponse.ok, true, importResponse.error);

      const cappedOptions = await openPage(
        browser,
        `chrome-extension://${extensionId}/options.html`,
      );
      try {
        const capped = await waitFor(async () => {
          const value = await cappedOptions.evaluate(`({
            count: document.querySelector("#domain-count").textContent,
            rows: document.querySelectorAll(".domain-row").length,
            note: document.querySelector("#empty").textContent,
            noteHidden: document.querySelector("#empty").hidden
          })`);
          return value.count === "600" ? value : null;
        }, 5_000, "capped domain list");
        assert.equal(capped.rows, 500);
        assert.equal(capped.noteHidden, false);
        assert.match(capped.note, /显示前 500 个，共 600 个结果/);
      } finally {
        await cappedOptions.close();
      }

      const responses = await optionsAgain.evaluate(`Promise.all([
        chrome.runtime.sendMessage({ type: "set-global", enabled: false }),
        chrome.runtime.sendMessage({ type: "set-theme", theme: "dark" })
      ])`);
      assert.equal(responses[0].ok, true, responses[0].error);
      assert.equal(responses[1].ok, true, responses[1].error);
    } finally {
      await optionsAgain.close();
    }

    const disabledState = await worker.evaluate(`Promise.all([
      chrome.declarativeNetRequest.getDynamicRules(),
      chrome.scripting.getRegisteredContentScripts(),
      chrome.privacy.websites.topicsEnabled.get({}),
      chrome.storage.local.get(null)
    ]).then(([rules, scripts, topics, storage]) => ({
      rules: rules.length,
      scripts: scripts.length,
      topics: topics.value,
      topicsControl: topics.levelOfControl,
      settings: storage.settings,
      domainCount: storage.domainCount,
      domainKeys: Object.keys(storage).filter((key) => key.startsWith("domain:")).length
    }))`);
    assert.equal(disabledState.rules, 0);
    assert.equal(disabledState.scripts, 0);
    assert.notEqual(disabledState.topicsControl, "controlled_by_this_extension");
    assert.equal(disabledState.settings.enabled, false);
    assert.equal(disabledState.settings.theme, "dark");
    assert.equal(disabledState.domainCount, disabledState.domainKeys);
  } finally {
    redirectServer.close();
    server.close();
    browser.close();
    if (chrome.exitCode === null) chrome.kill("SIGTERM");
    await new Promise((resolve) => {
      if (chrome.exitCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 2000);
      chrome.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (chrome.exitCode === null) chrome.kill("SIGKILL");
    await rm(profile, { recursive: true, force: true });
  }
});

function headerValues(rawHeaders, name) {
  const values = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index].toLowerCase() === name) values.push(rawHeaders[index + 1]);
  }
  return values;
}

async function openPage(browser, url, targetOptions = {}) {
  const { targetId } = await browser.send("Target.createTarget", {
    url,
    ...targetOptions,
  });
  const page = await browser.attach(targetId);
  await page.send("Page.enable");
  await waitFor(
    async () => (await page.evaluate("document.readyState")) === "complete",
    5_000,
    `page load: ${url}`,
  );
  return page;
}

async function captureUi(page, filename) {
  const directory = process.env.UI_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  const { data } = await page.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
  });
  await writeFile(path.join(directory, filename), data, "base64");
}

async function waitFor(check, timeout, description) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`);
}

class PipeCdp {
  constructor(writePipe, readPipe) {
    this.writePipe = writePipe;
    this.readPipe = readPipe;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);

    readPipe.on("data", (chunk) => this.onData(chunk));
    readPipe.on("error", (error) => this.rejectAll(error));
    readPipe.on("close", () => this.rejectAll(new Error("Chrome DevTools pipe closed")));
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.writePipe.write(`${JSON.stringify(message)}\0`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async attach(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    return new CdpSession(this, sessionId, targetId);
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const separator = this.buffer.indexOf(0);
      if (separator === -1) return;
      const raw = this.buffer.subarray(0, separator).toString("utf8");
      this.buffer = this.buffer.subarray(separator + 1);
      if (!raw) continue;

      const message = JSON.parse(raw);
      if (!message.id) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${message.error.message} (${message.error.code})`));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  rejectAll(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  close() {
    this.writePipe.end();
  }
}

class CdpSession {
  constructor(browser, sessionId, targetId) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.targetId = targetId;
  }

  send(method, params = {}) {
    return this.browser.send(method, params, this.sessionId);
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description
        || response.exceptionDetails.text);
    }
    return response.result.value;
  }

  async close() {
    await this.browser.send("Target.closeTarget", { targetId: this.targetId });
  }
}
