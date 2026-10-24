import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { getDataBaseDir, getPiGAgentDir, getPiGSessionDir } from "@zcode/services/node";

describe("PiG data paths", () => {
  it("derives the agent and session roots from the PI data root", () => {
    const previousEngine = process.env.PI_ENGINE;
    process.env.PI_ENGINE = "pig";
    try {
      const expectedRoot = join(getDataBaseDir(), ".pi-web", "pig-agent");
      expect(getPiGAgentDir()).toBe(expectedRoot);
      expect(getPiGSessionDir()).toBe(join(expectedRoot, "sessions"));
    } finally {
      if (previousEngine === undefined) delete process.env.PI_ENGINE;
      else process.env.PI_ENGINE = previousEngine;
    }
  });
});
