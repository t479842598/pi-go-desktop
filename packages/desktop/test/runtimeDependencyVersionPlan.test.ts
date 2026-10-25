import { describe, expect, it } from "vitest";

import { planNestedRuntimeDependencyCopies } from "../scripts/runtime-dependency-version-plan.mjs";

function dependency({ moduleName, consumerPackagePath, sourceModulePath }) {
  return { moduleName, consumerPackagePath, sourceModulePath };
}

describe("planNestedRuntimeDependencyCopies", () => {
  it("顶层版本已满足父包需求时不复制嵌套副本", () => {
    const plans = planNestedRuntimeDependencyCopies({
      resolvedDependencies: [
        dependency({
          moduleName: "signal-exit",
          consumerPackagePath: "/repo/node_modules/proper-lockfile/package.json",
          sourceModulePath: "/repo/node_modules/proper-lockfile/node_modules/signal-exit",
        }),
      ],
      asarPackageVersions: new Map([["signal-exit", "3.0.7"]]),
      asarPackageRoots: new Map([
        [
          "/repo/node_modules/proper-lockfile/package.json",
          "/staging/node_modules/proper-lockfile",
        ],
      ]),
      readVersion: (root) => (root.endsWith("signal-exit") ? "3.0.7" : undefined),
      readVersion: (root) => (root.endsWith("signal-exit") ? "3.0.7" : undefined),
    });

    expect(plans).toEqual([]);
  });

  it("顶层版本与父包真实依赖不一致时规划嵌套副本", () => {
    const plans = planNestedRuntimeDependencyCopies({
      resolvedDependencies: [
        dependency({
          moduleName: "signal-exit",
          consumerPackagePath: "/repo/node_modules/proper-lockfile/package.json",
          sourceModulePath: "/repo/node_modules/proper-lockfile/node_modules/signal-exit",
        }),
      ],
      asarPackageVersions: new Map([["signal-exit", "4.1.0"]]),
      asarPackageRoots: new Map([
        [
          "/repo/node_modules/proper-lockfile/package.json",
          "/staging/node_modules/proper-lockfile",
        ],
      ]),
      readVersion: (root) => (root.endsWith("signal-exit") ? "3.0.7" : undefined),
    });

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      moduleName: "signal-exit",
      requiredVersion: "3.0.7",
      topLevelVersion: "4.1.0",
      targetPath: "/staging/node_modules/proper-lockfile/node_modules/signal-exit",
    });
  });

  it("父包已有嵌套副本时不重复复制", () => {
    const consumerPackagePath = "/repo/node_modules/proper-lockfile/package.json";
    const plans = planNestedRuntimeDependencyCopies({
      resolvedDependencies: [
        dependency({
          moduleName: "signal-exit",
          consumerPackagePath,
          sourceModulePath: "/repo/node_modules/proper-lockfile/node_modules/signal-exit",
        }),
      ],
      asarPackageVersions: new Map([["signal-exit", "4.1.0"]]),
      asarPackageRoots: new Map([
        [consumerPackagePath, "/staging/node_modules/proper-lockfile"],
        [
          "/staging/node_modules/proper-lockfile/node_modules/signal-exit",
          "/staging/node_modules/proper-lockfile/node_modules/signal-exit",
        ],
      ]),
      readVersion: (root) => (root.endsWith("signal-exit") ? "3.0.7" : undefined),
    });

    expect(plans).toEqual([]);
  });
});
