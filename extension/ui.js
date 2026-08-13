export async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "Request failed");
  return response.value;
}

export function msg(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key;
}

export function localizeDocument(root = document) {
  const locale = msg("@@ui_locale").replaceAll("_", "-");
  if (locale) document.documentElement.lang = locale;

  for (const element of root.querySelectorAll("[data-i18n]")) {
    element.textContent = msg(element.dataset.i18n);
  }
  for (const attribute of ["aria-label", "placeholder", "title"]) {
    const dataAttribute = `data-i18n-${attribute}`;
    for (const element of root.querySelectorAll(`[${dataAttribute}]`)) {
      element.setAttribute(attribute, msg(element.getAttribute(dataAttribute)));
    }
  }
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

export function nextTheme(theme) {
  if (theme === "system") return "dark";
  if (theme === "dark") return "light";
  return "system";
}

export function themeLabel(theme) {
  return {
    system: msg("themeSystem"),
    light: msg("themeLight"),
    dark: msg("themeDark"),
  }[theme] || msg("themeSystem");
}

const DATE_FORMATTER = new Intl.DateTimeFormat(
  msg("@@ui_locale").replaceAll("_", "-"),
  { dateStyle: "medium", timeStyle: "short" },
);

export function formatDate(timestamp) {
  if (!Number.isFinite(timestamp)) return msg("unknown");
  try {
    return DATE_FORMATTER.format(timestamp);
  } catch {
    return msg("unknown");
  }
}

export function errorText(error) {
  const raw = error?.message || String(error);
  const exact = {
    "Request failed": "errorRequestFailed",
    "Unknown message": "errorUnknownMessage",
    "Unsupported host": "errorUnsupportedHost",
    "Invalid host": "errorInvalidHost",
    "Unsupported backup format": "errorUnsupportedBackup",
    "Invalid domain list": "errorInvalidDomainList",
    "Invalid domain entry": "errorInvalidDomainEntry",
    "Invalid domain flags": "errorInvalidDomainFlags",
    "Too many domains": "errorTooManyDomains",
    "Invalid settings": "errorInvalidSettings",
    "GPC support resource is too large": "errorSupportTooLarge",
  };
  if (exact[raw]) return msg(exact[raw]);

  const parent = /^Enable the parent exception first: (.+)$/.exec(raw);
  if (parent) return msg("errorEnableParentFirst", parent[1]);
  const limit = /^Domain limit reached \((\d+)\)$/.exec(raw);
  if (limit) return msg("errorDomainLimit", limit[1]);
  return raw;
}
