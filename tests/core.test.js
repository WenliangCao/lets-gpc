import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SETTINGS,
  MAX_DOMAINS,
  buildContentScript,
  buildGpcRule,
  classifyGpcSupport,
  domainStorageKey,
  hostFromUrl,
  hostToMatchPattern,
  isHostDisabled,
  normalizeHost,
  normalizeImportPayload,
  normalizeSettings,
} from "../extension/core.js";

test("hostFromUrl accepts only HTTP(S) and returns ASCII hostnames", () => {
  assert.equal(hostFromUrl("https://Example.COM./path"), "example.com");
  assert.equal(hostFromUrl("https://münich.example/path"), "xn--mnich-kva.example");
  assert.equal(hostFromUrl("chrome://extensions"), null);
  assert.equal(hostFromUrl("http://[::1]/"), "[::1]");
  assert.equal(hostFromUrl("not a url"), null);
});

test("normalizeHost rejects values unsafe for DNR domain conditions", () => {
  assert.equal(normalizeHost("Example.com"), "example.com");
  assert.equal(normalizeHost("https://example.com"), "example.com");
  assert.equal(normalizeHost("localhost"), "localhost");
  assert.equal(normalizeHost("127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeHost("999.0.0.1"), null);
  assert.equal(normalizeHost("example.com:8443"), null);
  assert.equal(normalizeHost("example.com/path"), null);
  assert.equal(normalizeHost("[::1]"), null);
  assert.equal(normalizeHost("ftp://example.com"), null);
  assert.equal(normalizeHost("-bad.example"), null);
});

test("normalizeSettings supplies defaults and canonicalizes exceptions", () => {
  assert.deepEqual(normalizeSettings(), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({
    enabled: false,
    blockTopics: false,
    theme: "dark",
    disabledHosts: ["B.example", "a.example", "b.example", "bad host"],
  }), {
    enabled: false,
    blockTopics: false,
    theme: "dark",
    disabledHosts: ["a.example", "b.example"],
  });
  assert.deepEqual(normalizeSettings({
    disabledHosts: ["cdn.example.com", "example.com", "a.cdn.example.com"],
  }).disabledHosts, ["example.com"]);
});

test("disabled parent domains cover their subdomains, never siblings", () => {
  const blocked = ["example.com"];
  assert.equal(isHostDisabled("example.com", blocked), true);
  assert.equal(isHostDisabled("cdn.example.com", blocked), true);
  assert.equal(isHostDisabled("notexample.com", blocked), false);
  assert.equal(isHostDisabled("example.org", blocked), false);
});

test("one DNR rule sets only Sec-GPC and excludes whole top-level sites", () => {
  const rule = buildGpcRule({
    enabled: true,
    disabledHosts: ["example.com"],
  });

  assert.equal(rule.id, 1);
  assert.deepEqual(rule.action.requestHeaders, [{
    header: "Sec-GPC",
    operation: "set",
    value: "1",
  }]);
  assert.equal("responseHeaders" in rule.action, false);
  assert.equal(rule.condition.regexFilter, "^(?:https?|wss?)://");
  assert.equal("excludedRequestDomains" in rule.condition, false);
  assert.deepEqual(rule.condition.excludedTopDomains, ["example.com"]);
  assert.equal(buildGpcRule({ enabled: false }), null);
});

test("MAIN-world script is registered only when enabled", () => {
  const script = buildContentScript({
    enabled: true,
    disabledHosts: ["example.com", "127.0.0.1"],
  });
  assert.equal(script.world, "MAIN");
  assert.equal(script.runAt, "document_start");
  assert.equal(script.allFrames, false);
  assert.deepEqual(script.excludeMatches, [
    "*://127.0.0.1/*",
    "*://*.example.com/*",
  ]);
  assert.equal(buildContentScript({ enabled: false }), null);
  assert.deepEqual(buildContentScript({ enabled: true }).excludeMatches, []);
  assert.equal(hostToMatchPattern("localhost"), "*://*.localhost/*");
});

test("GPC support resource classification follows content type and boolean", () => {
  assert.deepEqual(classifyGpcSupport({
    ok: true,
    contentType: "application/json; charset=utf-8",
    data: { gpc: true, lastUpdate: "2026-08-10" },
  }), { kind: "supported", lastUpdate: "2026-08-10" });

  assert.deepEqual(classifyGpcSupport({
    ok: true,
    contentType: "application/json",
    data: { gpc: false, lastUpdate: "yesterday" },
  }), { kind: "unsupported", lastUpdate: null });

  assert.equal(classifyGpcSupport({
    ok: true,
    contentType: "text/html",
    data: { gpc: true },
  }).kind, "unknown");

  assert.equal(classifyGpcSupport({
    ok: true,
    contentType: "application/json",
    data: { gpc: true, lastUpdate: "2026-02-29" },
  }).lastUpdate, null);
  assert.equal(classifyGpcSupport({
    ok: true,
    contentType: "application/json",
    data: { gpc: true, lastUpdate: "2024-02-29t23:59:60z" },
  }).lastUpdate, "2024-02-29t23:59:60z");
});

test("backup normalization validates the whole file and merges duplicates", () => {
  const imported = normalizeImportPayload({
    format: "lets-gpc",
    version: 1,
    settings: validImportSettings({ disabledHosts: ["blocked.example"] }),
    domains: [
      { host: "Example.com", lastSeen: 10, flags: 1 },
      { host: "example.com", lastSeen: 20, flags: 2 },
    ],
  });

  assert.deepEqual(imported.domains, [{
    host: "example.com",
    lastSeen: 20,
    flags: 3,
  }]);
  assert.deepEqual(imported.settings.disabledHosts, ["blocked.example"]);
  assert.throws(
    () => normalizeImportPayload({ format: "other", version: 1, domains: [] }),
    /Unsupported/,
  );
  assert.throws(
    () => normalizeImportPayload({
      format: "lets-gpc",
      version: 1,
      settings: validImportSettings(),
      domains: [{ host: "bad host", lastSeen: 1, flags: 1 }],
    }),
    /Invalid domain entry/,
  );
  assert.throws(
    () => normalizeImportPayload({
      format: "lets-gpc",
      version: 1,
      settings: validImportSettings(),
      domains: [{ host: "example.com", lastSeen: "1", flags: 1 }],
    }),
    /Invalid domain entry/,
  );
  assert.throws(
    () => normalizeImportPayload({
      format: "lets-gpc",
      version: 1,
      settings: validImportSettings(),
      domains: [{ host: "example.com", lastSeen: 1e100, flags: 1 }],
    }),
    /Invalid domain entry/,
  );
  assert.throws(
    () => normalizeImportPayload({
      format: "lets-gpc",
      version: 1,
      domains: [],
    }),
    /Invalid settings/,
  );
  assert.throws(
    () => normalizeImportPayload({
      format: "lets-gpc",
      version: 1,
      settings: validImportSettings({ theme: "neon" }),
      domains: [],
    }),
    /Invalid settings/,
  );
  assert.throws(
    () => normalizeImportPayload({
      format: "lets-gpc",
      version: 1,
      settings: validImportSettings({ disabledHosts: ["bad host"] }),
      domains: [],
    }),
    /Invalid settings/,
  );

  const maximumDomains = Array.from({ length: MAX_DOMAINS }, (_, index) => ({
    host: `domain-${index}.example`,
    lastSeen: index,
    flags: 1,
  }));
  assert.throws(
    () => normalizeImportPayload({
      format: "lets-gpc",
      version: 1,
      settings: validImportSettings({ disabledHosts: ["blocked.example"] }),
      domains: maximumDomains,
    }),
    /Too many domains/,
  );
});

test("domain storage keys are namespaced", () => {
  assert.equal(domainStorageKey("Example.com"), "domain:example.com");
  assert.equal(domainStorageKey("bad host"), null);
});

function validImportSettings(overrides = {}) {
  return {
    enabled: true,
    blockTopics: true,
    theme: "system",
    disabledHosts: [],
    ...overrides,
  };
}
