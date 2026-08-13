import {
  DEFAULT_SETTINGS,
  DOMAIN_COUNT_KEY,
  DOMAIN_KEY_PREFIX,
  GPC_RULE_ID,
  GPC_SCRIPT_ID,
  SETTINGS_KEY,
  MAX_DOMAINS,
  buildContentScript,
  buildGpcRule,
  disabledByHost,
  domainStorageKey,
  hostFromUrl,
  isHostDisabled,
  normalizeImportPayload,
  normalizeHost,
  normalizeSettings,
} from "./core.js";

const TOP_LEVEL = 1;
const RESOURCE = 2;
const DOMAIN_RECORD_TTL_MS = 5 * 60 * 1_000;
let mutationQueue = Promise.resolve();
let settingsCache;

chrome.runtime.onInstalled.addListener(() => {
  void enqueueMutation(installOrUpgrade).catch(reportError);
});

chrome.runtime.onStartup.addListener(() => {
  void enqueueMutation(() => reconcile()).catch(reportError);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  void enqueueMutation(
    () => handleNavigation(tabId, changeInfo.url, tab.incognito),
  ).catch(reportError);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(
    (value) => sendResponse({ ok: true, value }),
    (error) => sendResponse({ ok: false, error: error.message }),
  );
  return true;
});

async function installOrUpgrade() {
  const stored = await chrome.storage.local.get(null);
  const settings = normalizeSettings(stored[SETTINGS_KEY] || DEFAULT_SETTINGS);
  settingsCache = settings;
  const repair = planDomainRepair(stored, settings);
  if (repair.remove.length) await chrome.storage.local.remove(repair.remove);
  await chrome.storage.local.set(repair.update);
  await lockStorageToExtension();
  await chrome.action.setBadgeBackgroundColor({ color: "#16845b" });
  await reconcile(settings);
  await refreshBadges(settings);
}

async function handleMessage(message) {
  switch (message?.type) {
    case "get-state":
      return enqueueMutation(() => getState(message.url));
    case "get-export-data":
      return enqueueMutation(getExportData);
    case "set-global":
      return updateSettings((settings) => ({
        ...settings,
        enabled: Boolean(message.enabled),
      }), { signals: true, topics: true, badges: true });
    case "set-topics":
      return updateSettings((settings) => ({
        ...settings,
        blockTopics: Boolean(message.blocked),
      }), { topics: true });
    case "set-theme":
      return updateSettings((settings) => ({
        ...settings,
        theme: message.theme,
      }));
    case "set-host":
      return setHostEnabled(message.host, Boolean(message.enabled));
    case "record-hosts":
      return recordHosts(
        (Array.isArray(message.hosts) ? message.hosts : [])
          .slice(0, 512)
          .map((host) => ({ host, flags: RESOURCE })),
      );
    case "clear-domains":
      return clearDomains();
    case "forget-host":
      return forgetHost(message.host);
    case "import-data":
      return importData(message.data);
    default:
      throw new Error("Unknown message");
  }
}

async function getSettings() {
  if (settingsCache) return settingsCache;
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  settingsCache = normalizeSettings(stored[SETTINGS_KEY] || DEFAULT_SETTINGS);
  return settingsCache;
}

async function getState(url) {
  const settings = await getSettings();
  const host = hostFromUrl(url);
  const [topics, hostAccess] = await Promise.all([
    chrome.privacy.websites.topicsEnabled.get({}),
    host ? hasHostAccess(url) : false,
  ]);
  const exceptionSupported = Boolean(normalizeHost(host));
  const disabledBy = exceptionSupported
    ? disabledByHost(host, settings.disabledHosts)
    : null;

  return {
    settings,
    host,
    hostAccess,
    exceptionSupported,
    disabledBy,
    hostEnabled: Boolean(
      host && settings.enabled && !disabledBy,
    ),
    topics: {
      blocked: topics.value === false,
      levelOfControl: topics.levelOfControl,
    },
  };
}

async function getExportData() {
  const stored = await chrome.storage.local.get(null);
  settingsCache ||= normalizeSettings(stored[SETTINGS_KEY] || DEFAULT_SETTINGS);
  const settings = settingsCache;
  const domains = [];

  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(DOMAIN_KEY_PREFIX) || !Array.isArray(value)) continue;
    const rawHost = key.slice(DOMAIN_KEY_PREFIX.length);
    const host = normalizeHost(rawHost);
    if (!host || host !== rawHost) continue;
    domains.push({
      host,
      lastSeen: Number.isSafeInteger(value[0]) && value[0] >= 0 ? value[0] : 0,
      flags: Number.isInteger(value[1]) && value[1] >= 0 && value[1] <= 3
        ? value[1]
        : 0,
    });
  }

  domains.sort((a, b) => a.host.localeCompare(b.host));
  return { settings, domains };
}

function updateSettings(mutator, effects = {}) {
  return enqueueMutation(() => updateSettingsNow(mutator, effects));
}

async function updateSettingsNow(mutator, effects = {}) {
  const previous = await getSettings();
  const next = normalizeSettings(mutator(previous));
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  settingsCache = next;

  try {
    if (effects.signals) await reconcileSignals(next);
    if (effects.topics) await applyTopics(next);
    if (effects.badges) await refreshBadges(next);
    return next;
  } catch (error) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: previous });
    settingsCache = previous;
    if (effects.signals) await reconcileSignals(previous);
    if (effects.topics) await applyTopics(previous);
    if (effects.badges) await refreshBadges(previous);
    throw error;
  }
}

function setHostEnabled(hostValue, enabled) {
  const host = normalizeHost(hostValue);
  if (!host) return Promise.reject(new Error("Unsupported host"));
  return enqueueMutation(() => setHostEnabledNow(host, enabled));
}

async function setHostEnabledNow(host, enabled) {
  const settings = await getSettings();
  const disabled = new Set(settings.disabledHosts);

  if (enabled) {
    const inherited = disabledByHost(host, settings.disabledHosts);
    if (inherited && inherited !== host) {
      throw new Error(`Enable the parent exception first: ${inherited}`);
    }
    disabled.delete(host);
  } else {
    for (const item of disabled) {
      if (item.endsWith(`.${host}`)) disabled.delete(item);
    }
    if (!disabled.has(host) && disabled.size >= MAX_DOMAINS) {
      throw new Error(`Domain limit reached (${MAX_DOMAINS})`);
    }
    disabled.add(host);
  }

  const next = normalizeSettings({ ...settings, disabledHosts: [...disabled] });
  const reservation = !enabled && !isHostDisabled(host, settings.disabledHosts)
    ? await reserveDomainRecord(host, next)
    : null;

  try {
    return await updateSettingsNow(
      () => next,
      { signals: true, badges: true },
    );
  } catch (error) {
    await reservation?.undo();
    throw error;
  }
}

async function reconcile(settingsValue) {
  const settings = settingsValue || await getSettings();
  await reconcileSignals(settings);
  await applyTopics(settings);
}

async function reconcileSignals(settings) {
  const rule = buildGpcRule(settings);
  const script = buildContentScript(settings);

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [GPC_RULE_ID],
    addRules: rule ? [rule] : [],
  });

  const registered = await chrome.scripting.getRegisteredContentScripts({
    ids: [GPC_SCRIPT_ID],
  });
  if (script && registered.length) {
    await chrome.scripting.updateContentScripts([script]);
  } else if (registered.length) {
    await chrome.scripting.unregisterContentScripts({ ids: [GPC_SCRIPT_ID] });
  } else if (script) {
    await chrome.scripting.registerContentScripts([script]);
  }
}

async function applyTopics(settings) {
  const topicsSetting = chrome.privacy.websites.topicsEnabled;
  try {
    if (settings.enabled && settings.blockTopics) {
      await topicsSetting.set({ value: false, scope: "regular" });
    } else {
      await topicsSetting.clear({ scope: "regular" });
    }
  } catch (error) {
    // Enterprise policy or a higher-priority extension may own this setting.
    // GPC remains functional and the UI reports the effective Topics value.
    reportError(error);
  }
}

function normalizeHostEntries(entries) {
  return entries
    .map(({ host, flags }) => ({ host: normalizeHost(host), flags }))
    .filter(({ host, flags }) => (
      host && Number.isInteger(flags) && flags > 0 && flags <= 3
    ));
}

function recordHosts(entries) {
  const normalized = normalizeHostEntries(entries);
  if (!normalized.length) return Promise.resolve(0);
  return enqueueMutation(() => recordHostsNow(normalized));
}

async function handleNavigation(tabId, url, incognito) {
  if (!incognito) {
    const normalized = normalizeHostEntries([
      { host: hostFromUrl(url), flags: TOP_LEVEL },
    ]);
    if (normalized.length) {
      await recordHostsNow(normalized, { loadSettings: true });
    }
  }
  await updateBadge(tabId, url, settingsCache || await getSettings());
}

async function recordHostsNow(normalized, { loadSettings = false } = {}) {
  const keys = [...new Set(normalized.map(
    ({ host }) => `${DOMAIN_KEY_PREFIX}${host}`,
  ))];
  const requestedKeys = [...keys, DOMAIN_COUNT_KEY];
  if (loadSettings && !settingsCache) requestedKeys.push(SETTINGS_KEY);
  const stored = await chrome.storage.local.get(requestedKeys);
  if (loadSettings && !settingsCache) {
    settingsCache = normalizeSettings(stored[SETTINGS_KEY] || DEFAULT_SETTINGS);
  }

  let domainCount = Number.isInteger(stored[DOMAIN_COUNT_KEY])
    ? Math.max(0, stored[DOMAIN_COUNT_KEY])
    : 0;
  const now = Date.now();
  const updates = {};
  let added = 0;

  for (const { host, flags } of normalized) {
    const key = `${DOMAIN_KEY_PREFIX}${host}`;
    const current = updates[key] || (Array.isArray(stored[key]) ? stored[key] : null);
    if (!current) {
      if (domainCount >= MAX_DOMAINS) continue;
      domainCount += 1;
      added += 1;
    }
    const nextFlags = (current?.[1] || 0) | flags;
    if (
      current
      && nextFlags === current[1]
      && current[0] <= now
      && now - current[0] < DOMAIN_RECORD_TTL_MS
    ) {
      continue;
    }
    updates[key] = [now, nextFlags];
  }

  if (added) updates[DOMAIN_COUNT_KEY] = domainCount;
  if (!Object.keys(updates).length) return 0;
  await chrome.storage.local.set(updates);
  return Object.keys(updates).filter((key) => key.startsWith(DOMAIN_KEY_PREFIX)).length;
}

function clearDomains() {
  return enqueueMutation(clearDomainsNow);
}

async function clearDomainsNow() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((key) => key.startsWith(DOMAIN_KEY_PREFIX));
  await updateSettingsNow(
    (settings) => ({ ...settings, disabledHosts: [] }),
    { signals: true, badges: true },
  );
  if (keys.length) await chrome.storage.local.remove(keys);
  await chrome.storage.local.set({ [DOMAIN_COUNT_KEY]: 0 });
  return keys.length;
}

function forgetHost(hostValue) {
  const host = normalizeHost(hostValue);
  if (!host) return Promise.reject(new Error("Unsupported host"));
  return enqueueMutation(() => forgetHostNow(host));
}

async function forgetHostNow(host) {
  await updateSettingsNow(
    (settings) => ({
      ...settings,
      disabledHosts: settings.disabledHosts.filter((item) => item !== host),
    }),
    { signals: true, badges: true },
  );
  const key = domainStorageKey(host);
  const stored = await chrome.storage.local.get([key, DOMAIN_COUNT_KEY]);
  await chrome.storage.local.remove(key);
  if (Object.hasOwn(stored, key)) {
    const count = Number.isInteger(stored[DOMAIN_COUNT_KEY])
      ? stored[DOMAIN_COUNT_KEY]
      : 1;
    await chrome.storage.local.set({
      [DOMAIN_COUNT_KEY]: Math.max(0, count - 1),
    });
  }
  return host;
}

function importData(payload) {
  const imported = normalizeImportPayload(payload);
  return enqueueMutation(() => importDataNow(imported));
}

async function importDataNow(imported) {
  const previous = await chrome.storage.local.get(null);
  const previousSettings = normalizeSettings(previous[SETTINGS_KEY] || DEFAULT_SETTINGS);
  const previousKeys = Object.keys(previous).filter((key) => key.startsWith(DOMAIN_KEY_PREFIX));
  const updates = { [SETTINGS_KEY]: imported.settings };

  for (const entry of imported.domains) {
    updates[domainStorageKey(entry.host)] = [entry.lastSeen, entry.flags];
  }
  for (const host of imported.settings.disabledHosts) {
    const key = domainStorageKey(host);
    updates[key] ||= [0, 0];
  }

  const nextKeys = Object.keys(updates).filter((key) => key.startsWith(DOMAIN_KEY_PREFIX));
  updates[DOMAIN_COUNT_KEY] = nextKeys.length;
  const previousKeySet = new Set(previousKeys);
  const nextKeySet = new Set(nextKeys);
  try {
    await chrome.storage.local.set(updates);
    settingsCache = imported.settings;
    await reconcile(imported.settings);
    const obsolete = previousKeys.filter((key) => !nextKeySet.has(key));
    if (obsolete.length) await chrome.storage.local.remove(obsolete);
    await refreshBadges(imported.settings);
    return { imported: nextKeys.length };
  } catch (error) {
    const introduced = nextKeys.filter((key) => !previousKeySet.has(key));
    if (introduced.length) await chrome.storage.local.remove(introduced);
    const restore = { [SETTINGS_KEY]: previousSettings };
    restore[DOMAIN_COUNT_KEY] = Number.isInteger(previous[DOMAIN_COUNT_KEY])
      ? previous[DOMAIN_COUNT_KEY]
      : previousKeys.length;
    for (const key of previousKeys) restore[key] = previous[key];
    await chrome.storage.local.set(restore);
    settingsCache = previousSettings;
    await reconcile(previousSettings);
    throw error;
  }
}

async function refreshBadges(settingsValue) {
  const tabs = await chrome.tabs.query({
    url: ["http://*/*", "https://*/*"],
  });
  await Promise.allSettled(
    tabs.map((tab) => updateBadge(tab.id, tab.url, settingsValue)),
  );
}

async function updateBadge(tabId, url, settingsValue) {
  if (!Number.isInteger(tabId)) return;
  const [settings, hostAccess] = await Promise.all([
    settingsValue || getSettings(),
    hasHostAccess(url),
  ]);
  const host = hostFromUrl(url);
  const active = Boolean(
    host
    && hostAccess
    && settings.enabled
    && !isHostDisabled(host, settings.disabledHosts),
  );

  await Promise.all([
    chrome.action.setBadgeText({ tabId, text: active ? "1" : "" }),
    chrome.action.setTitle({
      tabId,
      title: active
        ? chrome.i18n.getMessage("badgeConfigured", host)
        : host && !hostAccess
          ? chrome.i18n.getMessage("badgeNoAccess", host)
          : chrome.i18n.getMessage("extensionName"),
    }),
  ]);
}

async function hasHostAccess(urlValue) {
  try {
    const url = new URL(urlValue);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return chrome.permissions.contains({
      origins: [`${url.protocol}//${url.hostname}/*`],
    });
  } catch {
    return false;
  }
}

async function lockStorageToExtension() {
  if (!chrome.storage.local.setAccessLevel) return;
  await chrome.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
}

function planDomainRepair(stored, settings) {
  const entries = new Map();
  const remove = [];
  const update = { [SETTINGS_KEY]: settings };

  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(DOMAIN_KEY_PREFIX)) continue;
    const rawHost = key.slice(DOMAIN_KEY_PREFIX.length);
    const host = normalizeHost(rawHost);
    if (!host || host !== rawHost || !Array.isArray(value)) {
      remove.push(key);
      continue;
    }

    const lastSeen = Number.isSafeInteger(value[0]) && value[0] >= 0
      ? value[0]
      : 0;
    const flags = Number.isInteger(value[1]) && value[1] >= 0 && value[1] <= 3
      ? value[1]
      : 0;
    const normalized = [lastSeen, flags];
    entries.set(key, normalized);
    if (lastSeen !== value[0] || flags !== value[1]) update[key] = normalized;
  }

  const protectedKeys = new Set();
  for (const host of settings.disabledHosts) {
    const key = domainStorageKey(host);
    protectedKeys.add(key);
    if (!entries.has(key)) {
      entries.set(key, [0, 0]);
      update[key] = [0, 0];
    }
  }

  if (entries.size > MAX_DOMAINS) {
    const disposable = [...entries]
      .filter(([key]) => !protectedKeys.has(key))
      .sort(([, a], [, b]) => a[0] - b[0]);
    for (const [key] of disposable.slice(0, entries.size - MAX_DOMAINS)) {
      entries.delete(key);
      delete update[key];
      remove.push(key);
    }
  }

  update[DOMAIN_COUNT_KEY] = entries.size;
  return { remove: [...new Set(remove)], update };
}

async function reserveDomainRecord(host, settings) {
  const key = domainStorageKey(host);
  const stored = await chrome.storage.local.get([key, DOMAIN_COUNT_KEY]);
  if (Object.hasOwn(stored, key)) return null;

  const previousCount = Number.isInteger(stored[DOMAIN_COUNT_KEY])
    ? Math.max(0, stored[DOMAIN_COUNT_KEY])
    : 0;
  let nextCount = previousCount + 1;
  let evicted = null;

  if (nextCount > MAX_DOMAINS) {
    const all = await chrome.storage.local.get(null);
    const protectedKeys = new Set(settings.disabledHosts.map(domainStorageKey));
    const candidates = Object.entries(all)
      .filter(([candidate, value]) => (
        candidate.startsWith(DOMAIN_KEY_PREFIX)
        && candidate !== key
        && !protectedKeys.has(candidate)
        && Array.isArray(value)
      ))
      .sort(([, a], [, b]) => (Number(a[0]) || 0) - (Number(b[0]) || 0));
    if (!candidates.length) throw new Error(`Domain limit reached (${MAX_DOMAINS})`);
    evicted = { key: candidates[0][0], value: candidates[0][1] };
    await chrome.storage.local.remove(evicted.key);
    nextCount = previousCount;
  }

  try {
    await chrome.storage.local.set({
      [key]: [0, 0],
      [DOMAIN_COUNT_KEY]: nextCount,
    });
  } catch (error) {
    if (evicted) await chrome.storage.local.set({ [evicted.key]: evicted.value });
    throw error;
  }

  return {
    async undo() {
      await chrome.storage.local.remove(key);
      const restore = { [DOMAIN_COUNT_KEY]: previousCount };
      if (evicted) restore[evicted.key] = evicted.value;
      await chrome.storage.local.set(restore);
    },
  };
}

function enqueueMutation(task) {
  const operation = mutationQueue.then(task);
  mutationQueue = operation.catch(() => {});
  return operation;
}

function reportError(error) {
  console.error("Let's GPC:", error);
}
