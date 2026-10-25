import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * 判断 app.asar 内某个父包能否解析到版本兼容的依赖。
 *
 * 打包注入只按“顶层 node_modules 是否存在同名目录”判断，会把顶层 v4 当成
 * proper-lockfile 需要的 signal-exit@^3 满足，结果运行时拿到具名导出的 v4，
 * `require("signal-exit")` 不再是函数 → `onExit is not a function` → sql_failed。
 */

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function satisfiesComparator(version, comparator) {
  const match = /^(\^|~|>=|<=|>|<|=)?\s*(\d+)\.(\d+)\.(\d+)$/.exec(comparator.trim());
  if (!match) return null;
  const [, operator = "=", major, minor, patch] = match;
  const target = [Number(major), Number(minor), Number(patch)];
  const order = compareVersions(version, target);

  switch (operator) {
    case "=":
      return order === 0;
    case ">":
      return order > 0;
    case ">=":
      return order >= 0;
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
    case "~":
      return order >= 0 && version[0] === target[0] && version[1] === target[1];
    case "^": {
      if (order < 0) return false;
      // 0.x 的 caret 只允许同一 minor 内浮动，与 npm 语义一致。
      if (target[0] === 0) return version[0] === 0 && version[1] === target[1];
      return version[0] === target[0];
    }
    default:
      return null;
  }
}

/** 只支持本仓库依赖实际使用的简单 semver 区间；无法解析时返回 null。 */
export function satisfiesVersionRange(versionText, rangeText) {
  const version = parseVersion(versionText);
  if (!version) return null;

  const alternatives = String(rangeText)
    .split("||")
    .map((part) => part.trim())
    .filter(Boolean);
  if (alternatives.length === 0) return null;

  let evaluated = false;
  for (const alternative of alternatives) {
    const comparators = alternative.split(/\s+/).filter(Boolean);
    let all = true;
    for (const comparator of comparators) {
      const result = satisfiesComparator(version, comparator);
      if (result === null) return null;
      evaluated = true;
      if (!result) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return evaluated ? false : null;
}

export function readPackageVersion(packageRoot) {
  try {
    const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 返回依赖在 `consumerPackageRoot` 视角下已存在的候选目录列表，
 * 顺序与 Node 解析一致：自身 node_modules → 上溯祖先 node_modules。
 */
export function resolveDependencyCandidates(dependencyName, consumerPackageRoot, boundaryRoot) {
  const candidates = [];
  let current = consumerPackageRoot;
  for (;;) {
    candidates.push(resolve(current, "node_modules", dependencyName));
    const parent = dirname(current);
    if (parent === current) break;
    if (boundaryRoot && !parent.startsWith(boundaryRoot)) break;
    current = parent;
  }
  return candidates;
}

/**
 * 找出需要以嵌套形式随包注入的依赖。
 *
 * `resolvedDependencies` 是运行时闭包收集器给出的条目，带 `consumerPackagePath`
 * 时表示该依赖是从这个父包解析到的真实版本。当该真实版本的来源包与
 * app.asar 内父包将要解析到的版本不一致，就必须写入父包自身的嵌套
 * `node_modules`，否则运行时会拿到顶层那份不兼容版本。
 */
export function planNestedRuntimeDependencyCopies({
  resolvedDependencies,
  asarPackageVersions,
  asarPackageRoots,
  readVersion = readPackageVersion,
}) {
  const plans = [];
  for (const dependency of resolvedDependencies) {
    const { moduleName, consumerPackagePath, sourceModulePath } = dependency;
    if (!consumerPackagePath || !sourceModulePath) continue;

    const requiredVersion = readVersion(sourceModulePath);
    if (!requiredVersion) continue;

    const consumerRoot = asarPackageRoots.get(consumerPackagePath);
    if (!consumerRoot) continue;

    const topLevelVersion = asarPackageVersions.get(moduleName);
    if (!topLevelVersion) continue;
    if (topLevelVersion === requiredVersion) continue;

    // 只有父包自身还没有嵌套副本时才需要注入。
    const nestedPath = resolve(consumerRoot, "node_modules", moduleName);
    if (asarPackageRoots.has(nestedPath)) continue;

    plans.push({
      moduleName,
      sourceModulePath,
      targetPath: nestedPath,
      requiredVersion,
      topLevelVersion,
    });
  }
  return plans;
}

export function directoryExists(path) {
  return existsSync(path);
}
