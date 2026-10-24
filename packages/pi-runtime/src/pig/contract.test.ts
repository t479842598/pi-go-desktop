import { describe, expect, it } from "vitest";

import { pigRuntimeModule } from "./module.js";
import type { PigRuntimeContract } from "./contract.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("pig-runtime contract", () => {
  it("declares its module manifest", () => {
    expect(pigRuntimeModule.id).toBe("pig-runtime");
    expect(pigRuntimeModule.publicEntrypoints).toContain("contract.ts");
  });

  it("keeps the public contract independent of a process implementation", () => {
    const contract: PigRuntimeContract = {
      start: async () => {},
      request: async <T>() => undefined as T,
      subscribe: () => () => {},
      getState: () => "exited",
      shutdown: async () => {},
    };
    expect(contract.getState()).toBe("exited");
  });
});
