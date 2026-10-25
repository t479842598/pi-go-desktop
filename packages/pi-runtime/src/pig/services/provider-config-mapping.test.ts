import { describe, expect, it } from "vitest";

import { asZCodeApiType, isPiProviderId, modelConfigFromPi } from "./provider-config-mapping.js";

describe("PiG provider config mapping", () => {
  it("maps supported API types and defaults unknown values to chat completions", () => {
    expect(asZCodeApiType("anthropic-messages")).toBe("anthropic-messages");
    expect(asZCodeApiType("openai-responses")).toBe("openai-responses");
    expect(asZCodeApiType("custom-api")).toBe("openai-chat-completions");
    expect(asZCodeApiType(undefined)).toBe("openai-chat-completions");
  });

  it("projects model context, input modalities, and supported reasoning levels", () => {
    const mapped = modelConfigFromPi(
      {
        id: "vision-model",
        contextWindow: 64_000,
        maxTokens: 8_192,
        input: ["image", "audio"],
        reasoning: true,
        thinkingLevelMap: { low: "low", high: null },
      },
      true,
    );

    expect(mapped.enabled).toBe(true);
    expect(mapped.properties.contextWindow).toBe(64_000);
    expect(mapped.properties.inputFormat).toMatchObject({
      supportsText: true,
      supportsImage: true,
      supportsVideo: false,
      supportsAudio: true,
      supportsPdf: false,
    });
    expect(mapped.optionSpecs?.reasoningLevel?.values).toEqual(["low"]);
    expect(mapped.optionSpecs?.maxOutputTokens?.max).toBe(8_192);
  });

  it("accepts Pi provider IDs but excludes account and UUID identifiers", () => {
    expect(isPiProviderId("pi-custom-provider")).toBe(true);
    expect(isPiProviderId("deepseek")).toBe(true);
    expect(isPiProviderId("account:personal")).toBe(false);
    expect(isPiProviderId("00000000-0000-4000-8000-000000000000")).toBe(false);
  });
});
