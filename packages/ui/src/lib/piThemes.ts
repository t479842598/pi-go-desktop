/**
 * pi-web 的 23 套主题作为 ZCode 明暗主题之上的覆盖层。
 *
 * pi-themes.css 为每套主题生成两份变量（html.dark / html:not(.dark)），所以选一套
 * PI 主题 + 保留用户的基础明暗（zai-dark/zai-light/system）即可整页换肤。选择落在
 * localStorage("pi-theme")，空值 = 不覆盖（纯 ZCode 基础主题）。
 */

export const PI_THEME_NONE = "";

/** id 即 pi-themes.css 的 data-pi-theme 键；label 展示用。 */
export const PI_THEMES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "aura", label: "Aura" },
  { id: "ayu", label: "Ayu" },
  { id: "carbonfox", label: "Carbonfox" },
  { id: "catppuccin", label: "Catppuccin" },
  { id: "claude", label: "Claude" },
  { id: "dracula", label: "Dracula" },
  { id: "fields-of-the-shire", label: "Fields of the Shire" },
  { id: "flexoki", label: "Flexoki" },
  { id: "gruvbox", label: "Gruvbox" },
  { id: "jetbrains", label: "JetBrains" },
  { id: "kanagawa", label: "Kanagawa" },
  { id: "mono", label: "Mono" },
  { id: "mono-plus", label: "Mono Plus" },
  { id: "monokai", label: "Monokai" },
  { id: "night-owl", label: "Night Owl" },
  { id: "nord", label: "Nord" },
  { id: "one-dark-pro", label: "One Dark Pro" },
  { id: "openchamber", label: "OpenChamber" },
  { id: "solarized", label: "Solarized" },
  { id: "tokyonight", label: "Tokyo Night" },
  { id: "vesper", label: "Vesper" },
  { id: "vitesse-dark", label: "Vitesse Dark" },
  { id: "vitesse-light", label: "Vitesse Light" },
];

const STORAGE_KEY = "pi-theme";

export function readStoredPiTheme(): string {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY) ?? "";
    return PI_THEMES.some((theme) => theme.id === value) ? value : PI_THEME_NONE;
  } catch {
    return PI_THEME_NONE;
  }
}

/** 把选择落到 <html data-pi-theme>；空串移除属性（恢复基础主题）。 */
export function applyPiTheme(id: string): void {
  const root = document.documentElement;
  if (id && PI_THEMES.some((theme) => theme.id === id)) {
    root.dataset.piTheme = id;
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* 私有模式等场景静默降级为会话内生效 */
    }
  } else {
    delete root.dataset.piTheme;
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* 同上 */
    }
  }
}
