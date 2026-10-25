#!/usr/bin/env node

import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCommand, runCommandAndReadStdout } from "../../../scripts/spawn-command.mjs";
import { getTargetPlatform } from "./target-platform.mjs";

export const PIG_MODULE = "github.com/MichaelKinsy/PiG";
export const PIG_MODULE_VERSION = "v0.3.1-0.20261025020319-b6d8ab0bfab0";
export const PIG_COMMIT = "b6d8ab0bfab082857274770e69eda0d477b263b2";
export const PIG_BUILD_ID = PIG_COMMIT.slice(0, 12);
export const PIG_VERSION = "0.5.3+1.4.0.74f46864";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const target = getTargetPlatform();

export function resolveGoTarget(platform) {
  return {
    goos: platform.os === "win32" ? "windows" : platform.os,
    goarch: platform.arch === "x64" ? "amd64" : platform.arch,
    binaryName: platform.os === "win32" ? "pig.exe" : "pig",
  };
}

export function resolvePigStagePath(platform = target) {
  const { binaryName } = resolveGoTarget(platform);
  return resolve(desktopRoot, "bundled-tools", platform.key, "pig", binaryName);
}

export function assertExpectedPigVersion(stdout, expectedVersion = PIG_VERSION) {
  const version = stdout.trim();
  if (!version.includes(expectedVersion)) {
    throw new Error(
      `PiG version mismatch: expected ${expectedVersion}, got ${version || "<empty>"}`,
    );
  }
}

function assertPiGModuleMetadata(binaryPath, expectedModuleVersion = PIG_MODULE_VERSION) {
  const metadata = runCommandAndReadStdout("go", ["version", "-m", binaryPath], {
    cwd: desktopRoot,
  });
  if (!metadata.includes(`path\t${PIG_MODULE}/cmd/pig`)) {
    throw new Error(`PiG module path mismatch: ${binaryPath}`);
  }
  if (expectedModuleVersion && !metadata.includes(`mod\t${PIG_MODULE}\t${expectedModuleVersion}`)) {
    throw new Error(`PiG module version mismatch: expected ${expectedModuleVersion}`);
  }
}

export function canExecuteTarget(platform) {
  return platform.os === process.platform && platform.arch === process.arch;
}

function resolveExplicitSourcePath() {
  const value = process.env.PIG_EXECUTABLE?.trim();
  return value ? resolve(value) : undefined;
}

function resolveLocalSourceDir() {
  const value = process.env.PIG_SOURCE_DIR?.trim();
  return value ? resolve(value) : undefined;
}

const PIG_BUILD_LD_FLAGS = `-s -w -X github.com/MichaelKinsy/PiG/coding/cli.Build=${PIG_BUILD_ID}`;

function buildFromSource(sourceDir, outputPath, goTarget) {
  if (!existsSync(resolve(sourceDir, "go.mod"))) {
    throw new Error(`PiG source directory has no go.mod: ${sourceDir}`);
  }
  runCommand(
    "go",
    ["build", "-trimpath", "-ldflags", PIG_BUILD_LD_FLAGS, "-o", outputPath, "./cmd/pig"],
    {
      cwd: sourceDir,
      env: {
        ...process.env,
        GOOS: goTarget.goos,
        GOARCH: goTarget.goarch,
        CGO_ENABLED: "0",
      },
    },
  );
}

function buildFromModule(outputPath, goTarget) {
  const tempDir = mkdtempSync(join(tmpdir(), "zcode-pig-build-"));
  try {
    const gobin = join(tempDir, "bin");
    mkdirSync(gobin, { recursive: true });
    runCommand(
      "go",
      ["install", "-ldflags", PIG_BUILD_LD_FLAGS, `${PIG_MODULE}/cmd/pig@${PIG_MODULE_VERSION}`],
      {
        cwd: desktopRoot,
        env: {
          ...process.env,
          GOBIN: gobin,
          GOOS: goTarget.goos,
          GOARCH: goTarget.goarch,
          CGO_ENABLED: "0",
        },
      },
    );
    const builtPath = join(gobin, goTarget.binaryName);
    if (!existsSync(builtPath)) {
      throw new Error(`PiG go install produced no binary: ${builtPath}`);
    }
    cpSync(builtPath, outputPath);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}

export function stagePigRuntime({
  sourcePath = resolveExplicitSourcePath(),
  sourceDir = resolveLocalSourceDir(),
} = {}) {
  const goTarget = resolveGoTarget(target);
  const outputPath = resolvePigStagePath(target);
  const stageDir = dirname(outputPath);
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  mkdirSync(stageDir, { recursive: true });
  rmSync(temporaryPath, { force: true });

  try {
    if (sourcePath) {
      if (!existsSync(sourcePath)) {
        throw new Error(`PIG_EXECUTABLE does not exist: ${sourcePath}`);
      }
      cpSync(sourcePath, temporaryPath);
      console.log(`[prepare:pig-runtime] staged explicit binary ${sourcePath}`);
    } else if (sourceDir) {
      buildFromSource(sourceDir, temporaryPath, goTarget);
      console.log(`[prepare:pig-runtime] built PiG from source ${sourceDir}`);
    } else {
      buildFromModule(temporaryPath, goTarget);
      console.log(`[prepare:pig-runtime] built PiG ${PIG_MODULE}@${PIG_VERSION}`);
    }

    if (!existsSync(temporaryPath)) {
      throw new Error(`PiG staging produced no binary: ${temporaryPath}`);
    }
    if (target.os !== "win32") chmodSync(temporaryPath, 0o755);
    assertPiGModuleMetadata(temporaryPath);
    if (canExecuteTarget(target)) {
      assertExpectedPigVersion(
        runCommandAndReadStdout(temporaryPath, ["--version"], { cwd: desktopRoot }),
      );
    }
    renameSync(temporaryPath, outputPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }

  console.log(`[prepare:pig-runtime] staged ${outputPath} (${goTarget.goos}/${goTarget.goarch})`);
  return outputPath;
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryHref === import.meta.url) {
  try {
    stagePigRuntime();
  } catch (error) {
    console.error(
      `[prepare:pig-runtime] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
