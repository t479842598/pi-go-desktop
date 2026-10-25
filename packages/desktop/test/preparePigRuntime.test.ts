import { describe, expect, it } from "vitest";

import {
  PIG_BUILD_ID,
  PIG_COMMIT,
  PIG_MODULE,
  PIG_MODULE_VERSION,
  PIG_VERSION,
  assertExpectedPigVersion,
  canExecuteTarget,
  resolveGoTarget,
  resolvePigStagePath,
} from "../scripts/prepare-pig-runtime.mjs";

describe("prepare PiG runtime", () => {
  it("pins the published Go module and version", () => {
    expect(PIG_MODULE).toBe("github.com/MichaelKinsy/PiG");
    expect(PIG_MODULE_VERSION).toBe("v0.3.1-0.20261025020319-b6d8ab0bfab0");
    expect(PIG_COMMIT).toBe("b6d8ab0bfab082857274770e69eda0d477b263b2");
    expect(PIG_BUILD_ID).toBe("b6d8ab0bfab0");
    expect(PIG_VERSION).toBe("0.5.3+1.4.0.74f46864");
  });

  it("rejects a PiG binary from a different pinned version", () => {
    expect(() => assertExpectedPigVersion("0.5.3+other-build")).toThrow(
      `PiG version mismatch: expected ${PIG_VERSION}`,
    );
    expect(() => assertExpectedPigVersion(`PiG ${PIG_VERSION}`)).not.toThrow();
  });

  it("uses the host to decide whether target CLI execution is valid", () => {
    expect(canExecuteTarget({ os: process.platform, arch: process.arch, key: "host" })).toBe(true);
    expect(
      canExecuteTarget({
        os: process.platform === "darwin" ? "linux" : "darwin",
        arch: process.arch,
        key: "other-os",
      }),
    ).toBe(false);
    expect(
      canExecuteTarget({
        os: process.platform,
        arch: process.arch === "arm64" ? "x64" : "arm64",
        key: "other-arch",
      }),
    ).toBe(false);
  });

  it("maps desktop targets to Go targets and staged executable names", () => {
    expect(resolveGoTarget({ os: "darwin", arch: "arm64", key: "darwin-arm64" })).toEqual({
      goos: "darwin",
      goarch: "arm64",
      binaryName: "pig",
    });
    expect(resolveGoTarget({ os: "win32", arch: "x64", key: "win32-x64" })).toEqual({
      goos: "windows",
      goarch: "amd64",
      binaryName: "pig.exe",
    });
  });

  it("uses one platform-scoped staging path", () => {
    expect(resolvePigStagePath({ os: "darwin", arch: "arm64", key: "darwin-arm64" })).toMatch(
      /bundled-tools[\\/]darwin-arm64[\\/]pig[\\/]pig$/,
    );
    expect(resolvePigStagePath({ os: "win32", arch: "x64", key: "win32-x64" })).toMatch(
      /bundled-tools[\\/]win32-x64[\\/]pig[\\/]pig\.exe$/,
    );
  });
});
