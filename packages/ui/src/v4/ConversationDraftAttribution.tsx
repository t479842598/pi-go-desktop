import { ZCODE_VERSION } from "@zcode/shared";

/**
 * 仅草稿欢迎屏展示项目出处。
 *
 * 早期这里把完整 GitHub URL 连同按钮一起显示，新会话首屏被一串地址占位；
 * 现在只保留项目名与版本号，仓库入口改由设置页/关于面板承担。
 */
export function ConversationDraftAttribution() {
  return (
    <div
      data-testid="zcode-selfhost-attribution"
      className="relative z-10 mt-2 text-center text-xs text-foreground-subtle"
    >
      <div className="font-medium text-foreground">PI · 青棠</div>
      <div className="mt-1 flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
        <span data-testid="zcode-selfhost-project" className="font-medium">
          pi-go-desktop
        </span>
        <span
          data-testid="zcode-selfhost-version"
          className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-foreground-subtle"
        >
          v{ZCODE_VERSION}
        </span>
      </div>
    </div>
  );
}
