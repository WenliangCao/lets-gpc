import {
  DOMAIN_KEY_PREFIX,
  disabledByHost,
  isHostDisabled,
  normalizeHost,
  normalizeSettings,
} from "./core.js";
import {
  applyTheme,
  formatDate,
  nextTheme,
  sendMessage,
  themeLabel,
} from "./ui.js";

const elements = Object.fromEntries(
  [
    "theme",
    "global-toggle",
    "topics-toggle",
    "topics-detail",
    "domain-count",
    "export",
    "import",
    "clear",
    "import-file",
    "search",
    "domain-list",
    "empty",
    "notice",
    "error",
  ].map((id) => [id, document.getElementById(id)]),
);

const MAX_RENDERED_DOMAINS = 500;
let state;
let domains = [];
let noticeTimer;

void initialize().catch(showError);

elements["global-toggle"].addEventListener("change", async (event) => {
  if (await mutate({ type: "set-global", enabled: event.target.checked })) {
    showNotice("设置已保存；已打开的页面在下次刷新后使用新信号。", true);
  }
});

elements["topics-toggle"].addEventListener("change", async (event) => {
  if (await mutate({ type: "set-topics", blocked: event.target.checked })) {
    showNotice("Topics 设置已更新。", true);
  }
});

elements.theme.addEventListener("click", async () => {
  await mutate({
    type: "set-theme",
    theme: nextTheme(state.settings.theme),
  });
});

elements.search.addEventListener("input", renderDomains);

elements.export.addEventListener("click", async () => {
  setBusy(true);
  hideMessages();
  try {
    const snapshot = await sendMessage({ type: "get-export-data" });
    const payload = {
      format: "lets-gpc",
      version: 1,
      exportedAt: new Date().toISOString(),
      ...snapshot,
    };
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `lets-gpc-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    showNotice("域名列表已导出。", true);
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
    render();
  }
});

elements.import.addEventListener("click", () => elements["import-file"].click());

elements["import-file"].addEventListener("change", async (event) => {
  const [file] = event.target.files;
  event.target.value = "";
  if (!file) return;
  if (file.size > 8_000_000) return showError(new Error("备份文件超过 8 MB"));

  try {
    const data = JSON.parse(await file.text());
    const result = await sendMessage({ type: "import-data", data });
    await refresh();
    showNotice(`已验证并导入 ${result.imported} 个域名。`, true);
  } catch (error) {
    showError(error);
  }
});

elements.clear.addEventListener("click", async () => {
  if (!confirm("清空所有域名记录和站点例外？全局设置将保留。")) return;
  try {
    const removed = await sendMessage({ type: "clear-domains" });
    await refresh();
    showNotice(`已清空 ${removed} 个域名记录。`, true);
  } catch (error) {
    showError(error);
  }
});

elements["domain-list"].addEventListener("change", async (event) => {
  const input = event.target.closest("input[data-host]");
  if (!input) return;
  try {
    await sendMessage({
      type: "set-host",
      host: input.dataset.host,
      enabled: input.checked,
    });
    await refresh();
    showNotice("站点例外已更新；刷新相关页面后完全生效。", true);
  } catch (error) {
    showError(error);
    await refresh();
  }
});

elements["domain-list"].addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-host]");
  if (!button) return;
  try {
    await sendMessage({ type: "forget-host", host: button.dataset.host });
    await refresh();
    showNotice(`已忘记 ${button.dataset.host}。`, true);
  } catch (error) {
    showError(error);
  }
});

async function initialize() {
  await refresh();
}

async function refresh() {
  state = await sendMessage({ type: "get-state", url: null });
  applyTheme(state.settings.theme);

  const stored = await chrome.storage.local.get(null);
  const byHost = new Map();
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(DOMAIN_KEY_PREFIX) || !Array.isArray(value)) continue;
    const rawHost = key.slice(DOMAIN_KEY_PREFIX.length);
    const host = normalizeHost(rawHost);
    if (!host || host !== rawHost) continue;
    byHost.set(host, {
      host,
      lastSeen: Number(value[0]) || 0,
      flags: Number(value[1]) & 3,
    });
  }

  for (const host of state.settings.disabledHosts) {
    if (!byHost.has(host)) byHost.set(host, { host, lastSeen: 0, flags: 0 });
  }

  domains = [...byHost.values()].sort(
    (a, b) => b.lastSeen - a.lastSeen || a.host.localeCompare(b.host),
  );
  render();
}

async function mutate(message) {
  setBusy(true);
  hideMessages();
  try {
    await sendMessage(message);
    await refresh();
    return true;
  } catch (error) {
    showError(error);
    await refresh();
    return false;
  } finally {
    setBusy(false);
    render();
  }
}

function render() {
  const settings = normalizeSettings(state.settings);
  elements["global-toggle"].checked = settings.enabled;
  elements["topics-toggle"].checked = settings.blockTopics;
  elements["topics-toggle"].disabled = !settings.enabled;
  elements.theme.textContent = `主题：${themeLabel(settings.theme)}`;
  elements["domain-count"].textContent = String(domains.length);
  elements["topics-detail"].textContent = state.topics.blocked
    ? "Topics API 当前已在浏览器级关闭。"
    : "Topics API 当前仍可用。";
  renderDomains();
}

function renderDomains() {
  const query = elements.search.value.trim().toLowerCase();
  const filtered = query
    ? domains.filter(({ host }) => host.includes(query))
    : domains;
  const visible = filtered.slice(0, MAX_RENDERED_DOMAINS);
  elements["domain-list"].replaceChildren(...visible.map(domainRow));
  elements.empty.hidden = filtered.length > 0
    && filtered.length <= MAX_RENDERED_DOMAINS;
  elements.empty.textContent = !domains.length
    ? "尚无域名记录。"
    : !filtered.length
      ? "没有匹配的域名。"
      : `显示前 ${MAX_RENDERED_DOMAINS} 个，共 ${filtered.length} 个结果；继续输入以缩小范围。`;
}

function domainRow(entry) {
  const row = document.createElement("div");
  row.className = "domain-row";

  const name = document.createElement("div");
  name.className = "domain-name";
  const host = document.createElement("strong");
  host.textContent = entry.host;
  host.title = entry.host;
  const type = document.createElement("span");
  const inherited = disabledByHost(entry.host, state.settings.disabledHosts);
  type.textContent = inherited && inherited !== entry.host
    ? `${flagsLabel(entry.flags)} · 受 ${inherited} 覆盖`
    : flagsLabel(entry.flags);
  name.append(host, type);

  const seen = document.createElement("span");
  seen.className = "last-seen";
  seen.textContent = entry.lastSeen ? formatDate(entry.lastSeen) : "仅作为例外保存";

  const label = document.createElement("label");
  label.className = "switch";
  label.setAttribute("aria-label", `${entry.host} 作为顶层网站时发送 GPC`);
  const input = document.createElement("input");
  input.type = "checkbox";
  input.dataset.host = entry.host;
  input.checked = !isHostDisabled(entry.host, state.settings.disabledHosts);
  input.disabled = !state.settings.enabled || Boolean(
    inherited && inherited !== entry.host,
  );
  if (inherited && inherited !== entry.host) {
    label.title = `请先启用父域 ${inherited}`;
  }
  label.append(input, document.createElement("span"));

  const forget = document.createElement("button");
  forget.className = "button";
  forget.type = "button";
  forget.dataset.host = entry.host;
  forget.textContent = "忘记";

  row.append(name, seen, label, forget);
  return row;
}

function flagsLabel(flags) {
  if (flags === 3) return "访问页面 · 资源域名";
  if (flags === 2) return "资源域名";
  if (flags === 1) return "访问页面";
  return "站点例外";
}

function setBusy(busy) {
  for (const control of document.querySelectorAll("button, input")) {
    control.disabled = busy;
  }
}

function showNotice(message, temporary = false) {
  clearTimeout(noticeTimer);
  elements.notice.textContent = message;
  elements.notice.hidden = false;
  elements.error.hidden = true;
  if (temporary) {
    noticeTimer = setTimeout(() => {
      elements.notice.hidden = true;
    }, 3200);
  }
}

function showError(error) {
  elements.error.textContent = error?.message || String(error);
  elements.error.hidden = false;
  elements.notice.hidden = true;
}

function hideMessages() {
  elements.error.hidden = true;
  elements.notice.hidden = true;
}
