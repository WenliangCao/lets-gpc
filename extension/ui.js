export async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "Request failed");
  return response.value;
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
    system: "跟随系统",
    light: "浅色",
    dark: "深色",
  }[theme] || "跟随系统";
}

export function formatDate(timestamp) {
  if (!Number.isFinite(timestamp)) return "未知";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(timestamp);
  } catch {
    return "未知";
  }
}
