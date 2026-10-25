import type { TaskFactsContract, TaskFactTarget } from "#src/task-facts/contract.js";
import type { ZCodeTaskMeta } from "@zcode/shared";
/** 调用者发送意图；不能先更新本地标题或另建重试队列。 */
export async function renameTaskExample(
  facts: TaskFactsContract,
  target: TaskFactTarget,
): Promise<ZCodeTaskMeta | null> {
  return facts.mutate(target, { type: "rename", title: "Review project" });
}
