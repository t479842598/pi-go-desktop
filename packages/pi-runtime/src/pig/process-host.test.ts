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

    const pending = host.request<{ ok: boolean }>("ping", { value: 1 });
    const request = await new Promise<string>((resolve) => {
      child.stdin.once("data", (chunk) => resolve(String(chunk).trim()));
    });
    const parsed = JSON.parse(request) as { id: string; command: string; params: { value: number } };
    expect(parsed.command).toBe("ping");
    expect(parsed.params.value).toBe(1);

    child.stdout.write(JSON.stringify({ type: "agent_start", sessionId: "s1" }) + "\n");
    child.stdout.write(JSON.stringify({ id: parsed.id, type: "response", success: true, data: { ok: true } }) + "\n");

    await expect(pending).resolves.toEqual({ ok: true });
    expect(events).toContainEqual({ type: "agent_start", sessionId: "s1" });
    await host.shutdown();
  });

  it("rejects a pending command when the process exits", async () => {
    const child = new FakeChild();
    const host = new PigProcessHost({
      spawnProcess: spawnFake(child),
      defaultTimeoutMs: 500,
    });
    await host.start();
    const pending = host.request("slow");
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
