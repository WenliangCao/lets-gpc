import {
  classifyGpcSupport,
  disabledByHost,
  hostFromUrl,
  isHostDisabled,
  normalizeHost,
} from "./core.js";
import {
  applyTheme,
  nextTheme,
  sendMessage,
  themeLabel,
} from "./ui.js";

const elements = Object.fromEntries(
  [
    "summary",
    "theme",
    "global-toggle",
    "unsupported",
    "site-content",
    "domain",
    "site-toggle",
    "site-detail",
    "header-status",
    "dom-status",
    "reload",
    "topics-toggle",
    "topics-detail",
    "resource-count",
    "resource-list",
    "support-status",
    "support-date",
    "error",
    "options",
  ].map((id) => [id, document.getElementById(id)]),
);

let activeTab;
let state;
let pageSnapshot;

void initialize().catch(showError);

elements["global-toggle"].addEventListener("change", async (event) => {
  if (await mutate({ type: "set-global", enabled: event.target.checked })) {
    markReloadRequired();
  }
});

elements["site-toggle"].addEventListener("change", async (event) => {
  if (await mutate({
    type: "set-host",
    host: state.host,
    enabled: event.target.checked,
  })) {
    markReloadRequired();
  }
});

elements["topics-toggle"].addEventListener("change", async (event) => {
  await mutate({ type: "set-topics", blocked: event.target.checked });
});

elements.theme.addEventListener("click", async () => {
  const theme = nextTheme(state.settings.theme);
  await mutate({ type: "set-theme", theme });
});

elements.reload.addEventListener("click", () => {
  if (activeTab?.id) void chrome.tabs.reload(activeTab.id);
  window.close();
});

elements.options.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

async function initialize() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state = await sendMessage({ type: "get-state", url: activeTab?.url });
  applyTheme(state.settings.theme);
  render();

  if (!state.host || !activeTab?.id) return;

  [pageSnapshot] = await Promise.all([
    inspectPage(activeTab.id, !activeTab.incognito),
    inspectSupport(activeTab.url),
  ]);
  renderPageSnapshot();
}

async function inspectPage(tabId, recordResources) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const hosts = new Set();
        for (const entry of performance.getEntriesByType("resource")) {
          try {
            const url = new URL(entry.name);
            if (url.protocol === "http:" || url.protocol === "https:") {
              hosts.add(url.hostname.toLowerCase());
            }
          } catch {}
        }

        return {
          gpc: navigator.globalPrivacyControl === true,
          gpcType: typeof navigator.globalPrivacyControl,
          hosts: [...hosts],
        };
      },
    });

    const snapshot = result?.result || { gpc: false, gpcType: "undefined", hosts: [] };
    const resourceHosts = snapshot.hosts
      .filter((host) => host !== state.host)
      .sort()
      .slice(0, 512);
    if (recordResources && resourceHosts.length) {
      await sendMessage({ type: "record-hosts", hosts: resourceHosts });
    }
    return { ...snapshot, hosts: resourceHosts };
  } catch {
    return { gpc: false, gpcType: "unavailable", hosts: [] };
  }
}

async function inspectSupport(urlValue) {
  const origin = new URL(urlValue).origin;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);

  try {
    const response = await fetch(`${origin}/.well-known/gpc.json`, {
      cache: "no-store",
      credentials: "omit",
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    let data = null;
    try {
      data = await readSmallJson(response);
    } catch {}

    renderSupport(classifyGpcSupport({
      ok: response.ok,
      contentType: response.headers.get("content-type") || "",
      data,
    }));
  } catch {
    renderSupport({ kind: "unknown", lastUpdate: null });
  } finally {
    clearTimeout(timeout);
  }
}

async function mutate(message) {
  setBusy(true);
  hideError();
  try {
    await sendMessage(message);
    state = await sendMessage({ type: "get-state", url: activeTab?.url });
    applyTheme(state.settings.theme);
    render();
    renderPageSnapshot();
    return true;
  } catch (error) {
    showError(error);
    state = await sendMessage({ type: "get-state", url: activeTab?.url });
    render();
    return false;
  } finally {
    setBusy(false);
    render();
    renderPageSnapshot();
  }
}

function render() {
  const settings = state.settings;
  const supported = Boolean(state.host);
  const active = state.hostEnabled;

  elements.summary.textContent = settings.enabled ? "保护已启用" : "保护已暂停";
  elements["global-toggle"].checked = settings.enabled;
  elements.unsupported.hidden = supported;
  elements["site-content"].hidden = !supported;
  elements.theme.title = `主题：${themeLabel(settings.theme)}`;

  if (!supported) return;

  elements.domain.textContent = state.host;
  elements.domain.title = state.host;
  elements["site-toggle"].checked = active;
  const inherited = state.disabledBy && state.disabledBy !== state.host;
  const exceptionUnavailable = !state.exceptionSupported;
  const missingAccess = !state.hostAccess;
  elements["site-toggle"].disabled = !settings.enabled
    || Boolean(inherited)
    || exceptionUnavailable;
  elements["site-detail"].hidden = !inherited
    && !exceptionUnavailable
    && !missingAccess;
  elements["site-detail"].textContent = exceptionUnavailable
    ? "当前地址仍使用全局 GPC，但 Chrome 的域名例外 API 不支持此地址类型。"
    : inherited
      ? `此站点由父域例外 ${state.disabledBy} 覆盖；请在域名列表中先启用父域。`
      : missingAccess
        ? "Chrome 未授予此站点的访问权限；扩展配置不会在这里生效。"
        : "";
  const headerActive = active && state.hostAccess;
  setPill(
    elements["header-status"],
    headerActive ? "发送 1" : active ? "无站点权限" : "不添加",
    headerActive,
  );
  elements["topics-toggle"].checked = settings.blockTopics;
  elements["topics-toggle"].disabled = !settings.enabled;

  const topicsControlled = state.topics.levelOfControl === "controlled_by_this_extension";
  elements["topics-detail"].textContent = state.topics.blocked
    ? topicsControlled
      ? "已由 Let's GPC 在浏览器级关闭"
      : "已关闭（可能由浏览器、策略或其他扩展控制）"
    : "当前未关闭";
}

function renderPageSnapshot() {
  if (!state?.host || !pageSnapshot) return;

  const visible = pageSnapshot.gpc;
  const configured = state.hostEnabled && state.hostAccess;
  if (
    pageSnapshot.gpcType !== "unavailable"
    && visible !== configured
  ) {
    markReloadRequired();
  }
  const label = visible
    ? "true"
    : pageSnapshot.gpcType === "undefined"
      ? "未暴露"
      : pageSnapshot.gpcType === "unavailable"
        ? "无法检测"
        : "false";
  setPill(elements["dom-status"], label, visible);

  elements["resource-count"].textContent = String(pageSnapshot.hosts.length);
  elements["resource-list"].replaceChildren(
    ...pageSnapshot.hosts.map(resourceRow),
  );

  if (!pageSnapshot.hosts.length) {
    const empty = document.createElement("p");
    empty.className = "muted note";
    empty.textContent = "当前没有可见的跨域资源条目。";
    elements["resource-list"].append(empty);
  }
}

function resourceRow(host) {
  const row = document.createElement("div");
  row.className = "resource-item";

  const name = document.createElement("code");
  name.textContent = host;
  name.title = host;

  const label = document.createElement("label");
  label.className = "switch";
  label.setAttribute("aria-label", `${host} 作为顶层网站时发送 GPC`);
  const exceptionSupported = Boolean(normalizeHost(host));
  const inherited = exceptionSupported
    ? disabledByHost(host, state.settings.disabledHosts)
    : null;
  if (!exceptionSupported) label.title = "此地址类型不支持域名例外";
  if (inherited && inherited !== host) {
    label.title = `由父域例外 ${inherited} 覆盖`;
  }

  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = state.settings.enabled
    && !isHostDisabled(host, state.settings.disabledHosts);
  input.disabled = !state.settings.enabled
    || !exceptionSupported
    || Boolean(inherited && inherited !== host);
  input.addEventListener("change", async () => {
    const affectsCurrent = isHostDisabled(state.host, [host]);
    if (
      await mutate({ type: "set-host", host, enabled: input.checked })
      && affectsCurrent
    ) {
      markReloadRequired();
    }
  });

  const track = document.createElement("span");
  label.append(input, track);
  row.append(name, label);
  return row;
}

function renderSupport(result) {
  const labels = {
    supported: "声明支持 GPC",
    unsupported: "声明不支持 GPC",
    unknown: "未提供有效声明",
  };
  elements["support-status"].textContent = labels[result.kind];
  elements["support-date"].textContent = result.lastUpdate
    ? `更新 ${result.lastUpdate}`
    : "支持声明不等于实际合规";
}

function setPill(element, text, on) {
  element.textContent = text;
  element.classList.toggle("on", on);
}

function markReloadRequired() {
  elements.reload.hidden = false;
}

function setBusy(busy) {
  for (const control of document.querySelectorAll("button, input")) {
    control.disabled = busy;
  }
}

async function readSmallJson(response) {
  if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(
    response.headers.get("content-type") || "",
  )) {
    await response.body?.cancel();
    return null;
  }

  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65_536) {
      await reader.cancel();
      throw new Error("GPC support resource is too large");
    }
    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return JSON.parse(text);
}

function showError(error) {
  elements.error.textContent = error?.message || String(error);
  elements.error.hidden = false;
}

function hideError() {
  elements.error.hidden = true;
}
