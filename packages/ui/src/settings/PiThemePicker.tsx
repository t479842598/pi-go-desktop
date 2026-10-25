/**
 * 「PI 主题」选择网格（设置 → 外观）。
 *
 * 每张卡片用该主题自己的变量渲染一个小预览（侧栏块 + 正文块 + 强调色圆点），
 * 点击即整页生效并持久化。数据源与侧栏菜单同一份（lib/piThemes）。
 */

import { useZCodeStore } from "@/store/StoreProvider.js";
import { PI_THEMES } from "@/lib/piThemes.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function PiThemePicker() {
  const { intl } = useZCodeIntl();
  const piTheme = useZCodeStore((state) => state.piTheme);
  const setPiTheme = useZCodeStore((state) => state.setPiTheme);

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        <button
          type="button"
          onClick={() => setPiTheme("")}
          className={`rounded-lg border p-0 text-left transition-shadow hover:shadow-md ${
            piTheme === "" ? "ring-2 ring-ring" : ""
          }`}
        >
          <div className="flex h-16 overflow-hidden rounded-t-lg bg-[var(--color-background,#161616)]">
            <div className="w-6 bg-[var(--color-sidebar,#1d1f21)]" />
            <div className="flex flex-1 flex-col gap-1 p-1.5">
              <div className="h-1.5 w-3/4 rounded bg-[var(--color-foreground,#e0e0e0)] opacity-70" />
              <div className="h-1.5 w-1/2 rounded bg-[var(--color-foreground,#e0e0e0)] opacity-40" />
            </div>
          </div>
          <div className="px-2 py-1.5 text-xs font-medium">
            {intl.formatMessage({ id: "sidebar.settings.piTheme.none" })}
          </div>
        </button>
        {PI_THEMES.map((theme) => (
          <button
            key={theme.id}
            type="button"
            onClick={() => setPiTheme(theme.id)}
            data-pi-theme-preview={theme.id}
            className={`rounded-lg border p-0 text-left transition-shadow hover:shadow-md ${
              piTheme === theme.id ? "ring-2 ring-ring" : ""
            }`}
          >
            {/* 预览块挂该主题的变量作用域；data-pi-theme-mode 固定用该主题的
                暗色变体渲染（预览以暗色为准，与 CSS 里 dark 选择器匹配）。 */}
            <div
              data-pi-theme={theme.id}
              data-pi-theme-mode="dark"
              className="dark flex h-16 overflow-hidden rounded-t-lg"
            >
              <div className="w-6 bg-[var(--color-sidebar,#1d1f21)]" />
              <div className="flex flex-1 flex-col gap-1 p-1.5">
                <div className="flex items-center gap-1">
                  <span className="inline-block size-2 rounded-full bg-[var(--color-accent,#4a89ff)]" />
                  <span className="h-1.5 w-2/3 rounded bg-[var(--color-foreground,#e0e0e0)] opacity-70" />
                </div>
                <span className="h-1.5 w-1/2 rounded bg-[var(--color-foreground,#e0e0e0)] opacity-40" />
              </div>
            </div>
            <div className="flex items-center justify-between px-2 py-1.5 text-xs font-medium">
              <span>{theme.label}</span>
              {piTheme === theme.id ? (
                <span className="text-[10px] text-emerald-500">
                  {intl.formatMessage({ id: "pi.theme.active" })}
                </span>
              ) : null}
            </div>
          </button>
        ))}
      </div>
      <p className="text-muted-foreground text-xs">
        {intl.formatMessage({ id: "pi.theme.hint" })}
      </p>
    </div>
  );
}
