/**
 * pig-runtime 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { PigRuntimeContract } from "./contract.js";

export async function examplePigRuntime(contract: PigRuntimeContract): Promise<void> {
  await contract.start();
  const dispose = contract.subscribe((event) => {
    if (event.type === "agent_settled") {
      // V4 projection consumes normalized lifecycle events in the real adapter.
    }
  });
  try {
    await contract.request("get_state", { sessionId: "example" });
  } finally {
    dispose();
    await contract.shutdown();
  }
}
