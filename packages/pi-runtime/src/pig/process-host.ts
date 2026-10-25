import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { getPiGAgentDir } from "@zcode/services/node";

import {
  PigRpcError,
  PigRuntimeError,
  type PigRequestOptions,
  type PigRuntimeContract,
  type PigRuntimeEvent,
  type PigRuntimeState,
} from "./contract.js";

export interface PigProcessHostOptions {
  /** Explicit executable path; defaults to the PIG_EXECUTABLE env or `pig`. */
  executable?: string;
  /** Arguments before the PiG RPC mode arguments. */
  args?: readonly string[];
  /** Agent directory passed through PIG_CODING_AGENT_DIR. */
  agentDir?: string;
  /** Spawn dependency for tests and alternate process hosts. */
  spawnProcess?: typeof spawn;
  /** Per-command timeout; callers can override for long-running commands. */
  defaultTimeoutMs?: number;
  /** Logger receives only diagnostics, never provider payloads. */
  log?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
}

type PendingRequest = {
  readonly command: string;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason?: unknown) => void;
};

type PigResponse = {
  id?: string | number | null;
  type?: string;
  command?: string;
  success?: boolean;
  data?: unknown;
  error?: string | { code?: string; message?: string; details?: unknown };
};

type SpawnedProcess = ChildProcessWithoutNullStreams;

/**
 * Owns one PiG RPC process. It deliberately does not expose child_process or
 * PiG wire objects to callers: V4 services consume this contract only.
 */
export class PigProcessHost implements PigRuntimeContract {
  private readonly listeners = new Set<(event: PigRuntimeEvent) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly executable: string;
  private readonly args: readonly string[];
  private readonly agentDir: string;
  private readonly defaultTimeoutMs: number;
  private readonly spawnProcess: typeof spawn;
  private readonly log: NonNullable<PigProcessHostOptions["log"]>;
  private process: SpawnedProcess | null = null;
  private lines: ReadlineInterface | null = null;
  private state: PigRuntimeState = "exited";
  private requestSequence = 0;
  private startPromise: Promise<void> | null = null;

  constructor(options: PigProcessHostOptions = {}) {
    this.executable = options.executable ?? process.env.PIG_EXECUTABLE ?? "pig";
    this.args = options.args ?? ["--mode", "rpc"];
    this.agentDir = options.agentDir ?? getPiGAgentDir();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.log = options.log ?? (() => {});
  }

  async start(): Promise<void> {
    if (this.state === "ready" && this.process) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.spawnAndAttach().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async request<T = unknown>(
    command: string,
    params: Record<string, unknown> = {},
    options: PigRequestOptions = {},
  ): Promise<T> {
    if (options.signal?.aborted) {
      throw new PigRuntimeError(
        "pig-command-aborted",
        `PiG command aborted before start: ${command}`,
      );
    }
    await this.start();
    if (!this.process || this.state !== "ready") {
      throw new PigRuntimeError("pig-not-ready", `PiG runtime is ${this.state}`);
    }

    const id = `${process.pid}-${++this.requestSequence}`;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    // PiG follows Pi's RPC command union: the command name is the top-level
    // `type`, and command fields are spread into the same JSON object. There is
    // no generic {type:"request",command,params} envelope.
    const wire = JSON.stringify({ ...params, id, type: command });

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        finish(() =>
          reject(new PigRuntimeError("pig-command-timeout", `PiG command timed out: ${command}`)),
        );
      }, timeoutMs);
      timer.unref?.();

      const onAbort = () => {
        if (!this.pending.has(id)) return;
        clearTimeout(timer);
        this.pending.delete(id);
        finish(() =>
          reject(new PigRuntimeError("pig-command-aborted", `PiG command aborted: ${command}`)),
        );
      };
      this.pending.set(id, {
        command,
        timer,
        resolve: (value) => finish(() => resolve(value as T)),
        reject: (reason) => finish(() => reject(reason)),
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        this.process!.stdin.write(`${wire}\n`);
      } catch (error) {
        options.signal?.removeEventListener("abort", onAbort);
        clearTimeout(timer);
        this.pending.delete(id);
        finish(() =>
          reject(
            new PigRuntimeError(
              "pig-stdin-write-failed",
              `Failed to send PiG command: ${command}`,
              { cause: error },
            ),
          ),
        );
      }
    });
  }

  subscribe(listener: (event: PigRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): PigRuntimeState {
    return this.state;
  }

  async shutdown(): Promise<void> {
    const process = this.process;
    if (!process) {
      this.state = "exited";
      return;
    }

    this.state = "stopping";
    this.lines?.close();
    this.lines = null;
    this.rejectPending(new PigRuntimeError("pig-shutdown", "PiG runtime shut down"));

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      process.once("close", finish);
      try {
        process.kill();
      } catch {
        finish();
      }
      const timer = setTimeout(finish, 2_000);
      timer.unref?.();
    });

    this.process = null;
    this.state = "exited";
  }

  private async spawnAndAttach(): Promise<void> {
    if (this.process) await this.shutdown();
    this.state = "starting";

    let child: SpawnedProcess;
    try {
      child = this.spawnProcess(this.executable, [...this.args], {
        env: {
          ...process.env,
          PIG_CODING_AGENT_DIR: this.agentDir,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.state = "failed";
      throw new PigRuntimeError("pig-spawn-failed", `Failed to spawn PiG: ${this.executable}`, {
        cause: error,
      });
    }

    this.process = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk) => {
      this.log("warn", `PiG stderr (${Buffer.byteLength(chunk)} bytes)`);
    });
    child.once("error", (error) => this.handleExit(error));
    child.once("close", (code, signal) => {
      this.handleExit(
        new PigRuntimeError(
          "pig-process-exited",
          `PiG exited code=${code ?? "null"} signal=${signal ?? "null"}`,
        ),
      );
    });

    this.state = "ready";
    this.emit({ type: "runtime_ready", agentDir: this.agentDir });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: PigResponse;
    try {
      message = JSON.parse(line) as PigResponse;
    } catch {
      this.log("warn", `PiG emitted invalid JSON (${Buffer.byteLength(line)} bytes)`);
      this.emit({ type: "runtime_error", code: "pig-invalid-json" });
      return;
    }

    if (message.id !== undefined && message.type === "response") {
      const id = String(message.id);
      const request = this.pending.get(id);
      if (!request) {
        this.log("warn", "PiG response had unknown request id");
        this.emit({ type: "runtime_error", code: "pig-unknown-response-id" });
        return;
      }
      clearTimeout(request.timer);
      this.pending.delete(id);
      if (message.success === false || message.error) {
        const errorObject = typeof message.error === "string" ? undefined : message.error;
        request.reject(
          new PigRpcError({
            code: errorObject?.code,
            message:
              typeof message.error === "string"
                ? message.error
                : (errorObject?.message ?? `PiG command failed: ${request.command}`),
            details: errorObject?.details,
          }),
        );
      } else {
        request.resolve(message.data);
      }
      return;
    }

    this.emit(message as PigRuntimeEvent);
  }

  private handleExit(reason: unknown): void {
    if (this.state === "stopping" || this.state === "exited" || this.state === "failed") return;
    this.process = null;
    this.lines?.close();
    this.lines = null;
    this.state = "failed";
    this.rejectPending(
      reason instanceof Error
        ? reason
        : new PigRuntimeError("pig-process-exited", "PiG process exited unexpectedly"),
    );
    this.emit({
      type: "runtime_exited",
      error: reason instanceof Error ? reason.message : String(reason),
    });
  }

  private rejectPending(reason: unknown): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(reason);
    }
    this.pending.clear();
  }

  private emit(event: PigRuntimeEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.log(
          "warn",
          `PiG listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
