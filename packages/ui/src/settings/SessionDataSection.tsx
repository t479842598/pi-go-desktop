/**
 * 「会话数据」设置分区：pi 会话整库导出/导入。
 *
 * 导出 = 宿主读 `~/.pi/agent/sessions/` 全部 .jsonl → 浏览器 Blob 下载
 * （pi-web 的导出同款交互）；导入 = 选快照文件 → 只回写本机不存在的会话，
 * 已存在一律跳过，覆盖事故在协议上就不可能发生。
 */

import { useCallback, useRef, useState } from "react";

import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { logger } from "@/logger.js";

interface SessionsDataApi {
  exportSessionsData?: () => Promise<unknown>;
  importSessionsData?: (payload: unknown) => Promise<{
    written: number;
    skippedExisting: number;
    skippedInvalid: number;
  }>;
}

export function SessionDataSection() {
  const { intl } = useZCodeIntl();
  const { taskGroupService } = useServices();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleExport = useCallback(async () => {
    setExporting(true);
    setMessage(null);
    try {
      const api = taskGroupService as unknown as SessionsDataApi;
      if (typeof api.exportSessionsData !== "function") {
        throw new Error("export unavailable");
      }
      const payload = await api.exportSessionsData();
      const entries = (payload as { entries?: unknown[] }).entries ?? [];
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `pi-sessions-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage(
        intl.formatMessage({ id: "pi.sessionData.exported" }, { count: entries.length }),
      );
    } catch (error) {
      logger.warn("[pi-session-data] 导出失败", error);
      setMessage(intl.formatMessage({ id: "pi.sessionData.failed" }));
    } finally {
      setExporting(false);
    }
  }, [intl, taskGroupService]);

  const handleImportFile = useCallback(
    async (file: File) => {
      setImporting(true);
      setMessage(null);
      try {
        const payload = JSON.parse(await file.text()) as unknown;
        const api = taskGroupService as unknown as SessionsDataApi;
        if (typeof api.importSessionsData !== "function") {
          throw new Error("import unavailable");
        }
        const result = await api.importSessionsData(payload);
        setMessage(
          intl.formatMessage(
            { id: "pi.sessionData.imported" },
            {
              written: result.written,
              skipped: result.skippedExisting + result.skippedInvalid,
            },
          ),
        );
      } catch (error) {
        logger.warn("[pi-session-data] 导入失败", error);
        setMessage(intl.formatMessage({ id: "pi.sessionData.failed" }));
      } finally {
        setImporting(false);
      }
    },
    [intl],
  );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-xs">
        {intl.formatMessage({ id: "pi.sessionData.hint" })}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={exporting} onClick={() => void handleExport()}>
          {exporting
            ? intl.formatMessage({ id: "pi.sessionData.exporting" })
            : intl.formatMessage({ id: "pi.sessionData.export" })}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={importing}
          onClick={() => fileInputRef.current?.click()}
        >
          {importing
            ? intl.formatMessage({ id: "pi.sessionData.importing" })
            : intl.formatMessage({ id: "pi.sessionData.import" })}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void handleImportFile(file);
          }}
        />
      </div>
      {message ? <p className="text-foreground text-xs">{message}</p> : null}
    </div>
  );
}
