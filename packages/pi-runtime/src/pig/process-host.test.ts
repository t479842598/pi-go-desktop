import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { PigProcessHost } from "./process-host.js";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    this.emit("close", 0, null);
    return true;
  }
}

function spawnFake(child: FakeChild) {
  return vi.fn(() => child as never) as never;
}

describe("PigProcessHost", () => {
  it("passes the workspace cwd and PiG agent dir to the child process", async () => {
    const child = new FakeChild();
    const spawnProcess = vi.fn(
      (
        _executable: string,
        _args: readonly string[],
        options: { cwd?: string; env?: NodeJS.ProcessEnv },
      ) => {
        expect(options.cwd).toBe("/workspace/project");
        expect(options.env?.PIG_CODING_AGENT_DIR).toBe("/workspace/project/.pig-agent");
        return child as never;
      },
    ) as never;
    const host = new PigProcessHost({
      executable: "pig-test",
      agentDir: "/workspace/project/.pig-agent",
      cwd: "/workspace/project",
      spawnProcess,
    });

    await host.start();
    expect(spawnProcess).toHaveBeenCalledOnce();
    await host.shutdown();
  });

  it("correlates responses and forwards notifications without exposing wire handling", async () => {
    const child = new FakeChild();
    const host = new PigProcessHost({
      executable: "pig-test",
      agentDir: "/tmp/pi-zcode-pig-test",
      spawnProcess: spawnFake(child),
      defaultTimeoutMs: 100,
    });
    const events: unknown[] = [];
    host.subscribe((event) => events.push(event));

    const pending = host.request<{ ok: boolean }>("prompt", {
      message: "hello",
      streamingBehavior: "followUp",
      id: "caller-id-must-not-win",
      type: "caller-type-must-not-win",
    });
    const request = await new Promise<string>((resolve) => {
      child.stdin.once("data", (chunk) => resolve(String(chunk).trim()));
    });
    const parsed = JSON.parse(request) as {
      id: string;
      type: string;
      message: string;
      streamingBehavior: string;
    };
    expect(parsed.type).toBe("prompt");
    expect(parsed.id).not.toBe("caller-id-must-not-win");
    expect(parsed.message).toBe("hello");
    expect(parsed.streamingBehavior).toBe("followUp");

    child.stdout.write(JSON.stringify({ type: "agent_start", sessionId: "s1" }) + "\n");
    child.stdout.write(
      JSON.stringify({
        id: parsed.id,
        type: "response",
        command: "prompt",
        success: true,
        data: { ok: true },
      }) + "\n",
    );

    await expect(pending).resolves.toEqual({ ok: true });
    expect(events).toContainEqual({ type: "agent_start", sessionId: "s1" });
    await host.shutdown();
  });

  it("maps PiG string errors to the local RPC error contract", async () => {
    const child = new FakeChild();
    const host = new PigProcessHost({ spawnProcess: spawnFake(child), defaultTimeoutMs: 100 });
    const pending = host.request("get_state");
    const request = await new Promise<string>((resolve) => {
      child.stdin.once("data", (chunk) => resolve(String(chunk).trim()));
    });
    const { id } = JSON.parse(request) as { id: string };

    child.stdout.write(
      JSON.stringify({
        id,
        type: "response",
        command: "get_state",
        success: false,
        error: "Unknown command: get_state",
      }) + "\n",
    );

    await expect(pending).rejects.toMatchObject({
      name: "PigRpcError",
      message: "Unknown command: get_state",
    });
    await host.shutdown();
  });

  it("rejects a pending command when the process exits", async () => {
    const child = new FakeChild();
    const host = new PigProcessHost({
      spawnProcess: spawnFake(child),
      defaultTimeoutMs: 500,
    });
    await host.start();
    const pending = host.request("get_state");
    await new Promise<void>((resolve) => child.stdin.once("data", () => resolve()));
    child.emit("close", 1, null);
    await expect(pending).rejects.toMatchObject({ code: "pig-process-exited" });
    expect(host.getState()).toBe("failed");
  });

  it("reports malformed JSON without resolving a request", async () => {
    const child = new FakeChild();
    const log = vi.fn();
    const host = new PigProcessHost({ spawnProcess: spawnFake(child), defaultTimeoutMs: 20, log });
    const pending = host.request("timeout");
    child.stdout.write("not-json\n");
    await expect(pending).rejects.toMatchObject({ code: "pig-command-timeout" });
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("invalid JSON"));
    await host.shutdown();
  });
});
