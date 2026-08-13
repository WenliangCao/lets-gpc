export const SETTINGS_KEY = "settings";
export const DOMAIN_KEY_PREFIX = "domain:";
export const DOMAIN_COUNT_KEY = "domainCount";
export const GPC_RULE_ID = 1;
export const GPC_SCRIPT_ID = "lets-gpc-main";
export const MAX_DOMAINS = 5_000;

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  blockTopics: true,
  theme: "system",
  disabledHosts: Object.freeze([]),
});

export const HTTP_MATCHES = Object.freeze([
  "http://*/*",
  "https://*/*",
]);

const RESOURCE_TYPES = Object.freeze([
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "webtransport",
  "webbundle",
  "other",
]);

const VALID_THEMES = new Set(["system", "light", "dark"]);
const VALID_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
const VALID_IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export function hostFromUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = canonicalHost(url.hostname);
    return host?.includes(":") ? host : normalizeHost(host);
  } catch {
    return null;
  }
}

export function normalizeHost(value) {
  if (typeof value !== "string") return null;

  const input = value.trim();
  if (!input) return null;

  try {
    const url = new URL(input.includes("://") ? input : `http://${input}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.port) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;

    const host = canonicalHost(url.hostname);
    if (!host || host.length > 253 || host.includes(":")) return null;
    if (!VALID_HOST.test(host)) return null;

    if (VALID_IPV4.test(host)) {
      const octets = host.split(".").map(Number);
      if (octets.some((octet) => octet > 255)) return null;
    }

    return host;
  } catch {
    return null;
  }
}

export function normalizeSettings(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const normalizedHosts = Array.isArray(source.disabledHosts)
    ? [...new Set(
      source.disabledHosts
        .slice(0, MAX_DOMAINS)
        .map(normalizeHost)
        .filter(Boolean),
    )]
    : [];
  const disabledHosts = collapseDisabledHosts(normalizedHosts);

  return {
    enabled: typeof source.enabled === "boolean"
      ? source.enabled
      : DEFAULT_SETTINGS.enabled,
    blockTopics: typeof source.blockTopics === "boolean"
      ? source.blockTopics
      : DEFAULT_SETTINGS.blockTopics,
    theme: VALID_THEMES.has(source.theme)
      ? source.theme
      : DEFAULT_SETTINGS.theme,
    disabledHosts,
  };
}

export function isHostDisabled(host, disabledHosts) {
  const current = canonicalHost(host);
  if (!current) return false;

  return disabledHosts.some(
    (blocked) => current === blocked || current.endsWith(`.${blocked}`),
  );
}

export function disabledByHost(host, disabledHosts) {
  const current = canonicalHost(host);
  if (!current) return null;
  return disabledHosts.find(
    (blocked) => current === blocked || current.endsWith(`.${blocked}`),
  ) || null;
}

export function buildGpcRule(settingsValue) {
  const settings = settingsValue || DEFAULT_SETTINGS;
  if (!settings.enabled) return null;

  const condition = {
    resourceTypes: [...RESOURCE_TYPES],
  };

  if (settings.disabledHosts?.length) {
    condition.excludedTopDomains = [...settings.disabledHosts];
  }

  return {
    id: GPC_RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        {
          header: "Sec-GPC",
          operation: "set",
          value: "1",
        },
      ],
    },
    condition,
  };
}

export function buildContentScript(settingsValue) {
  const settings = settingsValue || DEFAULT_SETTINGS;
  if (!settings.enabled) return null;

  const script = {
    id: GPC_SCRIPT_ID,
    js: ["gpc.js"],
    matches: [...HTTP_MATCHES],
    allFrames: false,
    excludeMatches: (settings.disabledHosts || []).map(hostToMatchPattern),
    persistAcrossSessions: true,
    runAt: "document_start",
    world: "MAIN",
  };

  return script;
}

export function hostToMatchPattern(hostValue) {
  const host = normalizeHost(hostValue);
  if (!host) throw new TypeError("Invalid host");
  if (VALID_IPV4.test(host)) return `*://${host}/*`;
  return `*://*.${host}/*`;
}

export function domainStorageKey(hostValue) {
  const host = normalizeHost(hostValue);
  return host ? `${DOMAIN_KEY_PREFIX}${host}` : null;
}

export function classifyGpcSupport({ ok, contentType, data }) {
  if (!ok || !/^application\/json(?:\s*;|$)/i.test(contentType || "")) {
    return { kind: "unknown", lastUpdate: null };
  }

  if (!data || typeof data !== "object" || typeof data.gpc !== "boolean") {
    return { kind: "unknown", lastUpdate: null };
  }

  return {
    kind: data.gpc ? "supported" : "unsupported",
    lastUpdate: validRfc3339(data.lastUpdate) ? data.lastUpdate : null,
  };
}

export function normalizeImportPayload(payload) {
  if (!payload || payload.format !== "lets-gpc" || payload.version !== 1) {
    throw new TypeError("Unsupported backup format");
  }
  if (!Array.isArray(payload.domains) || payload.domains.length > MAX_DOMAINS) {
    throw new TypeError("Invalid domain list");
  }
  const settings = validateImportedSettings(payload.settings);

  const byHost = new Map();
  for (const entry of payload.domains) {
    const host = normalizeHost(entry?.host);
    const lastSeen = entry?.lastSeen;
    const flags = entry?.flags;
    if (
      !host
      || typeof lastSeen !== "number"
      || !Number.isSafeInteger(lastSeen)
      || lastSeen < 0
    ) {
      throw new TypeError("Invalid domain entry");
    }
    if (typeof flags !== "number" || !Number.isInteger(flags) || flags < 0 || flags > 3) {
      throw new TypeError("Invalid domain flags");
    }

    const current = byHost.get(host) || { host, lastSeen: 0, flags: 0 };
    current.lastSeen = Math.max(current.lastSeen, lastSeen);
    current.flags |= flags;
    byHost.set(host, current);
  }

  const domains = [...byHost.values()].sort((a, b) => a.host.localeCompare(b.host));
  const allHosts = new Set(domains.map(({ host }) => host));
  for (const host of settings.disabledHosts) allHosts.add(host);
  if (allHosts.size > MAX_DOMAINS) throw new TypeError("Too many domains");

  return { settings, domains };
}

function canonicalHost(value) {
  if (typeof value !== "string") return null;
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  return host || null;
}

function collapseDisabledHosts(hosts) {
  const candidates = [...hosts].sort((a, b) => (
    a.split(".").length - b.split(".").length || a.localeCompare(b)
  ));
  const kept = [];
  const keptSet = new Set();

  for (const host of candidates) {
    if (hasHostOrParent(host, keptSet)) continue;
    kept.push(host);
    keptSet.add(host);
  }

  return kept.sort();
}

function hasHostOrParent(host, hosts) {
  if (hosts.has(host)) return true;
  if (VALID_IPV4.test(host)) return false;

  let separator = host.indexOf(".");
  while (separator !== -1) {
    const parent = host.slice(separator + 1);
    if (hosts.has(parent)) return true;
    separator = host.indexOf(".", separator + 1);
  }
  return false;
}

function validateImportedSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid settings");
  }
  if (
    typeof value.enabled !== "boolean"
    || typeof value.blockTopics !== "boolean"
    || !VALID_THEMES.has(value.theme)
    || !Array.isArray(value.disabledHosts)
    || value.disabledHosts.length > MAX_DOMAINS
    || value.disabledHosts.some((host) => !normalizeHost(host))
  ) {
    throw new TypeError("Invalid settings");
  }
  return normalizeSettings(value);
}

function validRfc3339(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d:(?:[0-5]\d|60)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/i.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;

  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1];
}
