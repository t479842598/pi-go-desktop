/**
 * pi 会话的整库导出/导入（比 pi-web 的只读 HTML 导出更强：可直接回导恢复）。
 *
 * 导出 = `<pig-agent>/sessions/` 全部 .jsonl 的逐行快照（含目录结构），供 UI 做
 * Blob 下载；导入 = 把快照里**本机不存在**的会话文件原样写回对应目录，已存在的
 * 一律跳过（绝不覆盖本机新内容）。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { defaultSessionsDir } from "./session-locator.js";

export interface PiSessionExportEntry {
  /** 相对 sessions 根的路径：`<encoded-cwd>/<filename>.jsonl` */
  relPath: string;
  /** 原始 jsonl 全文（逐行保留，导入时零损耗回写） */
  content: string;
}

export interface PiSessionExportPayload {
  kind: "pi-sessions-export";
  version: 1;
  exportedAt: string;
  entries: PiSessionExportEntry[];
}

export function exportPiSessions(sessionsDir = defaultSessionsDir()): PiSessionExportPayload {
  const entries: PiSessionExportEntry[] = [];
  for (const projectDir of safeReaddir(sessionsDir)) {
    const projectPath = join(sessionsDir, projectDir);
    for (const file of safeReaddir(projectPath)) {
      if (!file.endsWith(".jsonl")) continue;
      const full = join(projectPath, file);
      try {
        entries.push({ relPath: `${projectDir}/${file}`, content: readFileSync(full, "utf8") });
      } catch {
        /* 单文件读取失败跳过：导出是尽力而为的快照 */
      }
    }
  }
  return { kind: "pi-sessions-export", version: 1, exportedAt: new Date().toISOString(), entries };
}

export interface PiSessionImportResult {
  written: number;
  skippedExisting: number;
  skippedInvalid: number;
}

export function importPiSessions(
  payload: unknown,
  sessionsDir = defaultSessionsDir(),
): PiSessionImportResult {
  const result: PiSessionImportResult = { written: 0, skippedExisting: 0, skippedInvalid: 0 };
  if (!isExportPayload(payload)) return result;
  for (const entry of payload.entries) {
    // 路径安全：只允许 `<dir>/<file>.jsonl` 形态，禁止任何 `..`/绝对路径逃逸。
    if (!/^[^/\\]+\/+[^/\\]+\.jsonl$/.test(entry.relPath) || entry.relPath.includes("..")) {
      result.skippedInvalid += 1;
      continue;
    }
    if (!entry.content.trim()) {
      result.skippedInvalid += 1;
      continue;
    }
    const target = join(sessionsDir, entry.relPath);
    if (existsSync(target)) {
      result.skippedExisting += 1;
      continue;
    }
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.content, { mode: 0o600 });
      result.written += 1;
    } catch {
      result.skippedInvalid += 1;
    }
  }
  return result;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// ── 单会话 HTML 导出 ────────────────────────────────────────────────────────

interface HtmlExportMessage {
  role?: string;
  content?: unknown;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * 把一个 .jsonl 会话渲染成独立 HTML（无外部依赖，双击可看）。
 * 逐行解析：session 头取 cwd/时间；message 取 user/assistant 文本；
 * toolResult 渲染成折叠卡片。与 pi-web 的会话导出同思路，实现自含。
 */
export function exportSessionHtml(sessionFile: string): string {
  const lines = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean);
  let cwd = "";
  let startedAt = "";
  const body: string[] = [];
  let toolOrdinal = 0;

  for (const line of lines) {
    let entry: {
      type?: string;
      cwd?: string;
      timestamp?: string;
      message?: HtmlExportMessage;
      name?: string;
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "session") {
      cwd = entry.cwd ?? "";
      startedAt = entry.timestamp ?? "";
      continue;
    }
    if (entry.type === "session_info" && entry.name) {
      body.push(`<div class="meta">会话名称：${escapeHtml(entry.name)}</div>`);
      continue;
    }
    const message = entry.message;
    if (!message) continue;
    const role = message.role ?? "";
    if (role === "user" || role === "assistant") {
      const text = textOf(message.content);
      if (!text.trim()) continue;
      body.push(
        `<div class="msg ${role}"><div class="role">${role === "user" ? "用户" : "PI"}</div><div class="text">${escapeHtml(text)}</div></div>`,
      );
      continue;
    }
    if (role === "toolResult") {
      toolOrdinal += 1;
      const text = textOf(message.content);
      body.push(
        `<details class="tool"><summary>工具结果 #${toolOrdinal}</summary><pre>${escapeHtml(text.slice(0, 8000))}</pre></details>`,
      );
    }
  }

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>PI 会话导出 ${escapeHtml(startedAt)}</title>
<style>
body{font-family:-apple-system,"Segoe UI",sans-serif;max-width:860px;margin:24px auto;padding:0 16px;color:#1a1a1a;background:#fafafa}
h1{font-size:18px}.meta{color:#666;font-size:12px;margin:4px 0}
.msg{margin:14px 0;padding:12px 14px;border-radius:10px}
.msg.user{background:#e8f0fe}.msg.assistant{background:#ffffff;border:1px solid #e3e3e3}
.role{font-size:11px;font-weight:600;color:#888;margin-bottom:6px;text-transform:uppercase}
.text{white-space:pre-wrap;word-break:break-word;line-height:1.6;font-size:14px}
details.tool{margin:8px 0;font-size:12px;color:#555}
details.tool pre{background:#f0f0f0;padding:8px;border-radius:6px;overflow:auto;max-height:300px}
</style></head><body>
<h1>PI 会话导出</h1>
<div class="meta">开始：${escapeHtml(startedAt)} · 目录：${escapeHtml(cwd)}</div>
${body.join("\n")}
</body></html>`;
}

function isExportPayload(value: unknown): value is PiSessionExportPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "pi-sessions-export" &&
    Array.isArray((value as { entries?: unknown }).entries)
  );
}

/** 按 JSONL session header 的精确 id 找到会话文件。 */
export function resolveSessionFile(
  sessionId: string,
  sessionsDir = defaultSessionsDir(),
): string | null {
  for (const projectDir of safeReaddir(sessionsDir)) {
    const projectPath = join(sessionsDir, projectDir);
    for (const file of safeReaddir(projectPath)) {
      if (!file.endsWith(".jsonl")) continue;
      const sessionPath = join(projectPath, file);
      try {
        const firstLine = readFileSync(sessionPath, "utf8").split(/\r?\n/, 1)[0] ?? "";
        const header = JSON.parse(firstLine) as { type?: unknown; id?: unknown };
        if (header.type === "session" && header.id === sessionId) return sessionPath;
      } catch {
        // Ignore malformed or unreadable files while scanning other sessions.
      }
    }
  }
  return null;
}
