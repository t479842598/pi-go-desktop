import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { dirname } from "node:path";

import { defaultSessionsDir, locateSession } from "../session-locator.js";
import { PigProcessHost, type PigProcessHostOptions } from "./process-host.js";
import type { PigRuntimeEvent } from "./contract.js";

export type PiGSessionEvent = { type: string; [key: string]: unknown };
export type PiGSessionListener = (event: PiGSessionEvent) => void;

export interface PiGSessionState {
  model: { provider: string; id: string; modelId: string } | null;
  thinkingLevel: string;
  isStreaming: boolean;
  isCompacting: boolean;
  messages: AgentMessage[];
  usage: Record<string, number>;
  sessionFile?: string;
  sessionName?: string;
  sessionId: string;
  messageCount: number;
  pendingMessageCount: number;
  steeringMode: string;
  followUpMode: string;
}

export interface PiGSession {
  readonly sessionId: string;
  readonly state: PiGSessionState;
  prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<unknown>;
  abort(): Promise<void>;
  dispose(): void;
}

export interface RuntimeSessionHandle {
  readonly sessionId: string;
  readonly cwd: string;
  readonly session: {
    readonly sessionId: string;
    readonly state: unknown;
    prompt: (
      text: string,
      options?: { streamingBehavior?: "steer" | "followUp" },
    ) => Promise<unknown>;
    abort: () => Promise<unknown>;
    dispose?: () => void;
  };
  subscribe(listener: (event: PiGSessionEvent) => void): () => void;
  dispose(): void;
}

export interface RuntimeSessionHost {
  open(input: {
    cwd: string;
    sessionId?: string;
    sessionFile?: string;
  }): Promise<RuntimeSessionHandle>;
  get(sessionId: string): RuntimeSessionHandle | undefined;
  has(sessionId: string): boolean;
  cwdOf(sessionId: string): string | undefined;
  list(): string[];
  fork(handle: RuntimeSessionHandle, entryId: string): Promise<string>;
  close(sessionId: string): void;
  closeAll(): void;
}

export interface PiGSessionHandle extends RuntimeSessionHandle {
  readonly session: PiGSession;
}

export interface PiGSessionHostOptions {
  readonly agentDir?: string;
  readonly executable?: string;
  readonly spawnProcess?: PigProcessHostOptions["spawnProcess"];
  readonly sessionRoot?: string;
  readonly log?: PigProcessHostOptions["log"];
}

interface HostEntry {
  readonly handle: PiGSessionHandle;
  readonly runtime: PigProcessHost;
  readonly listeners: Set<PiGSessionListener>;
  readonly unsubscribe: () => void;
}

interface AssistantStreamAccumulator {
  message: AssistantMessage | null;
  readonly toolCallArguments: Map<number, string>;
}

/** Owns one isolated PiG RPC process per live session. */
export class PiGSessionHost implements RuntimeSessionHost {
  private readonly entries = new Map<string, HostEntry>();
  private readonly sessionRoot: string;

  constructor(private readonly options: PiGSessionHostOptions = {}) {
    this.sessionRoot = options.sessionRoot ?? defaultSessionsDir();
  }

  async open(input: {
    cwd: string;
    sessionId?: string;
    sessionFile?: string;
  }): Promise<PiGSessionHandle> {
    if (input.sessionId) {
      const existing = this.entries.get(input.sessionId);
      if (existing) return existing.handle;
      if (!input.sessionFile) {
        const located = await locateSession(input.sessionId, this.sessionRoot);
        if (!located) throw new Error(`Unknown PiG session: ${input.sessionId}`);
        input = { ...input, cwd: located.cwd, sessionFile: located.sessionFile };
      }
    }

    const runtime = new PigProcessHost({
      ...(this.options.agentDir
        ? { agentDir: this.options.agentDir }
        : { agentDir: dirname(this.sessionRoot) }),
      cwd: input.cwd,
      ...(this.options.executable ? { executable: this.options.executable } : {}),
      ...(this.options.spawnProcess ? { spawnProcess: this.options.spawnProcess } : {}),
      ...(this.options.log ? { log: this.options.log } : {}),
    });

    try {
      await runtime.start();
      if (input.sessionFile) {
        await runtime.request("switch_session", { sessionPath: input.sessionFile });
      } else {
        await runtime.request("new_session");
      }
      const state = await runtime.request<RuntimeStateSnapshot>("get_state");
      if (!state || typeof state.sessionId !== "string" || !state.sessionId) {
        throw new Error("PiG get_state returned no session id");
      }
      const initialMessages = await runtime.request<unknown>("get_messages").catch(() => undefined);
      const messages = readMessages(initialMessages);
      const handle = this.adopt(runtime, input.cwd, state, messages);
      return handle;
    } catch (error) {
      await runtime.shutdown();
      throw error;
    }
  }

  get(sessionId: string): PiGSessionHandle | undefined {
    return this.entries.get(sessionId)?.handle;
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  cwdOf(sessionId: string): string | undefined {
    return this.entries.get(sessionId)?.handle.cwd;
  }

  list(): string[] {
    return [...this.entries.keys()];
  }

  async fork(handle: RuntimeSessionHandle, entryId: string): Promise<string> {
    const entry = this.entries.get(handle.sessionId);
    if (!entry) throw new Error(`Unknown live PiG session: ${handle.sessionId}`);
    // PiG's fork command replaces the active runtime and may allocate a new
    // session file. Re-read the replacement snapshot and return the ID under
    // which the runtime was adopted, rather than the superseded handle ID.
    await entry.runtime.request("fork", { entryId });
    const state = await entry.runtime.request<RuntimeStateSnapshot>("get_state");
    const messagesResponse = await entry.runtime.request<unknown>("get_messages");
    entry.unsubscribe();
    entry.listeners.clear();
    this.entries.delete(handle.sessionId);
    const nextHandle = this.adopt(entry.runtime, handle.cwd, state, readMessages(messagesResponse));
    return nextHandle.sessionId;
  }

  async setSessionName(sessionId: string, name: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) throw new Error(`Unknown live PiG session: ${sessionId}`);
    await entry.runtime.request("set_session_name", { name });
  }

  async setThinkingLevel(sessionId: string, level: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) throw new Error(`Unknown live PiG session: ${sessionId}`);
    await entry.runtime.request("set_thinking_level", { level });
  }

  async setFollowUpMode(sessionId: string, mode: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) throw new Error(`Unknown live PiG session: ${sessionId}`);
    await entry.runtime.request("set_follow_up_mode", { mode });
  }

  async setSteeringMode(sessionId: string, mode: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) throw new Error(`Unknown live PiG session: ${sessionId}`);
    await entry.runtime.request("set_steering_mode", { mode });
  }

  close(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    entry.unsubscribe();
    entry.listeners.clear();
    entry.handle.session.dispose();
    void entry.runtime.shutdown();
  }

  closeAll(): void {
    for (const sessionId of [...this.entries.keys()]) this.close(sessionId);
  }

  private adopt(
    runtime: PigProcessHost,
    cwd: string,
    snapshot: RuntimeStateSnapshot,
    messages: AgentMessage[],
  ): PiGSessionHandle {
    const sessionId = snapshot.sessionId;
    if (this.entries.has(sessionId)) this.close(sessionId);
    const listeners = new Set<PiGSessionListener>();
    const state: PiGSessionState = {
      model: snapshot.model
        ? {
            provider: snapshot.model.provider,
            id: snapshot.model.id,
            modelId: snapshot.model.id,
          }
        : null,
      thinkingLevel: snapshot.thinkingLevel ?? "off",
      isStreaming: Boolean(snapshot.isStreaming),
      isCompacting: Boolean(snapshot.isCompacting),
      messages,
      usage: {},
      ...(snapshot.sessionFile ? { sessionFile: snapshot.sessionFile } : {}),
      ...(snapshot.sessionName ? { sessionName: snapshot.sessionName } : {}),
      sessionId,
      messageCount: snapshot.messageCount ?? messages.length,
      pendingMessageCount: snapshot.pendingMessageCount ?? 0,
      steeringMode: snapshot.steeringMode ?? "one-at-a-time",
      followUpMode: snapshot.followUpMode ?? "one-at-a-time",
    };
    const session: PiGSession = {
      sessionId,
      state,
      prompt: (text, options) =>
        runtime.request("prompt", {
          message: text,
          ...(options?.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
        }),
      abort: async () => {
        await runtime.request("abort");
      },
      dispose: () => {},
    };
    const handle: PiGSessionHandle = {
      sessionId,
      cwd,
      session,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      dispose: () => this.close(sessionId),
    };

    const assistantStream: AssistantStreamAccumulator = {
      message: null,
      toolCallArguments: new Map(),
    };
    const unsubscribe = runtime.subscribe((event) => {
      const messageEvent = normalizeMessageEvent(event, assistantStream);
      updateStateFromEvent(state, messageEvent);
      const normalized = normalizeEvent(messageEvent);
      for (const listener of [...listeners]) {
        try {
          listener(normalized);
        } catch (error) {
          this.options.log?.(
            "warn",
            `PiG session listener failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    });
    this.entries.set(sessionId, { handle, runtime, listeners, unsubscribe });
    return handle;
  }
}

interface RuntimeStateSnapshot {
  sessionId: string;
  model?: { provider: string; id: string } | null;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  sessionFile?: string;
  sessionName?: string;
  messageCount?: number;
  pendingMessageCount?: number;
  steeringMode?: string;
  followUpMode?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readMessages(value: unknown): AgentMessage[] {
  const record = asRecord(value);
  const items = Array.isArray(value) ? value : record?.messages;
  return Array.isArray(items) ? (items as AgentMessage[]) : [];
}

function updateStateFromEvent(state: PiGSessionState, event: PigRuntimeEvent): void {
  if (event.type === "agent_start") state.isStreaming = true;
  else if (event.type === "agent_end" || event.type === "agent_settled") state.isStreaming = false;
  const message = asRecord(event.message);
  if (
    message &&
    (event.type === "message_start" ||
      event.type === "message_update" ||
      event.type === "message_end")
  ) {
    const role = readString(message.role);
    const timestamp = message.timestamp;
    const key = `${role ?? "unknown"}:${String(timestamp ?? "")}`;
    const existingIndex = state.messages.findIndex((item) => {
      const candidate = item as unknown as { role?: string; timestamp?: unknown };
      return `${candidate.role ?? "unknown"}:${String(candidate.timestamp ?? "")}` === key;
    });
    if (existingIndex < 0) state.messages.push(message as unknown as AgentMessage);
    else state.messages[existingIndex] = message as unknown as AgentMessage;
    state.messageCount = state.messages.length;
  } else if (event.type === "session_info_changed") {
    state.sessionName = readString(event.name);
  } else if (event.type === "thinking_level_changed") {
    state.thinkingLevel = readString(event.level) ?? state.thinkingLevel;
  } else if (event.type === "compaction_start") {
    state.isCompacting = true;
  } else if (event.type === "compaction_end") {
    state.isCompacting = false;
  }
}

function normalizeMessageEvent(
  event: PigRuntimeEvent,
  accumulator: AssistantStreamAccumulator,
): PigRuntimeEvent {
  if (event.type === "message_start") {
    const message = readAssistantMessage(event.message);
    if (!message) return event;
    accumulator.message = cloneAssistantMessage(message);
    accumulator.toolCallArguments.clear();
    return { ...event, message: accumulator.message };
  }

  if (event.type === "message_update") {
    const eventMessage = readAssistantMessage(event.message);
    const current = eventMessage ? cloneAssistantMessage(eventMessage) : accumulator.message;
    if (!current) return event;

    const assistantEvent = asRecord(event.assistantMessageEvent);
    let message = eventMessage
      ? current
      : assistantEvent
        ? applyAssistantMessageDelta(current, assistantEvent, accumulator.toolCallArguments)
        : current;
    const usage = asRecord(event.usage);
    if (usage) message = { ...message, usage: usage as unknown as AssistantMessage["usage"] };
    accumulator.message = message;
    return { ...event, message };
  }

  if (event.type === "message_end") {
    const message = readAssistantMessage(event.message);
    const finalMessage = message ? cloneAssistantMessage(message) : accumulator.message;
    if (!finalMessage) return event;
    accumulator.message = null;
    accumulator.toolCallArguments.clear();
    return { ...event, message: finalMessage };
  }

  return event;
}

function readAssistantMessage(value: unknown): AssistantMessage | undefined {
  const message = asRecord(value);
  return message?.role === "assistant" && Array.isArray(message.content)
    ? (message as unknown as AssistantMessage)
    : undefined;
}

function cloneAssistantMessage(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.map((block) => ({ ...block })),
  };
}

function applyAssistantMessageDelta(
  message: AssistantMessage,
  event: Record<string, unknown>,
  toolCallArguments: Map<number, string>,
): AssistantMessage {
  const index = event.contentIndex;
  if (
    typeof index !== "number" ||
    !Number.isInteger(index) ||
    index < 0 ||
    index > message.content.length
  ) {
    return message;
  }

  const content = [...message.content];
  const existing = content[index];
  switch (event.type) {
    case "text_start":
      if (existing?.type !== "text") content[index] = { type: "text", text: "" };
      break;
    case "text_delta":
      if (typeof event.delta !== "string") return message;
      content[index] = {
        ...(existing?.type === "text" ? existing : { type: "text" as const, text: "" }),
        text: `${existing?.type === "text" ? existing.text : ""}${event.delta}`,
      };
      break;
    case "text_end":
      if (typeof event.content !== "string") return message;
      content[index] = {
        ...(existing?.type === "text" ? existing : { type: "text" as const, text: "" }),
        text: event.content,
      };
      break;
    case "thinking_start":
      if (existing?.type !== "thinking") content[index] = { type: "thinking", thinking: "" };
      break;
    case "thinking_delta":
      if (typeof event.delta !== "string") return message;
      content[index] = {
        ...(existing?.type === "thinking" ? existing : { type: "thinking" as const, thinking: "" }),
        thinking: `${existing?.type === "thinking" ? existing.thinking : ""}${event.delta}`,
      };
      break;
    case "thinking_end":
      if (typeof event.content !== "string") return message;
      content[index] = {
        ...(existing?.type === "thinking" ? existing : { type: "thinking" as const, thinking: "" }),
        thinking: event.content,
      };
      break;
    case "toolcall_start": {
      const id = readString(event.id);
      const name = readString(event.toolName);
      if (!id || !name) return message;
      toolCallArguments.set(index, "");
      content[index] = {
        type: "toolCall",
        id,
        name,
        arguments: existing?.type === "toolCall" ? existing.arguments : {},
        ...(existing?.type === "toolCall" && existing.thoughtSignature
          ? { thoughtSignature: existing.thoughtSignature }
          : {}),
      };
      break;
    }
    case "toolcall_delta": {
      if (typeof event.delta !== "string" || existing?.type !== "toolCall") return message;
      const argumentsJson = `${toolCallArguments.get(index) ?? ""}${event.delta}`;
      toolCallArguments.set(index, argumentsJson);
      const parsed = parseToolCallArguments(argumentsJson);
      if (parsed) content[index] = { ...existing, arguments: parsed };
      break;
    }
    case "toolcall_end": {
      const call = asRecord(event.toolCall);
      if (
        !call ||
        call.type !== "toolCall" ||
        typeof call.id !== "string" ||
        typeof call.name !== "string"
      ) {
        return message;
      }
      content[index] = call as unknown as ToolCall;
      toolCallArguments.delete(index);
      break;
    }
    default:
      return message;
  }

  return { ...message, content };
}

function parseToolCallArguments(value: string): ToolCall["arguments"] | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    const record = asRecord(parsed);
    return record as ToolCall["arguments"] | undefined;
  } catch {
    return undefined;
  }
}

function normalizeEvent(event: PigRuntimeEvent): PiGSessionEvent {
  if (event.type === "runtime_error" || event.type === "runtime_exited") {
    return { ...event, type: "agent_runtime_error" };
  }
  return event as PiGSessionEvent;
}
