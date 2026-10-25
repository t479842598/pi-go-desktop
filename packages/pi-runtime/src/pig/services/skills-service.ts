/**
 * pi-backed skills service.
 *
 * pi discovers skills from SKILL.md files in two roots: user
 * (`<pig-agent>/skills/`) and project (`<workspace>/.agents/skills/`). A skill
 * is disabled for the model by flipping the `disable-model-invocation`
 * frontmatter key — the same surgical edit pi-web performs, so the user's
 * formatting survives.
 *
 * The ZCode skill UI maps scope names directly: user → `<pig-agent>/skills`,
 * workspace → `<workspace>/.agents/skills`. `plugin` scope exists in the type
 * but pi has no plugin-owned skills, so the list simply never contains one.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { SkillScope, SkillsListResult, SkillsPromptContext } from "@zcode/shared";
import { ISkillsService } from "@zcode/services";

import { getPiGAgentDir } from "@zcode/services/node";
import { withServiceFallbacks } from "../../service-fallbacks.js";

interface ParsedSkill {
  id: string;
  name: string;
  description: string;
  path: string;
  scope: SkillScope;
  enabled: boolean;
  body: string;
}

function userSkillsDir(): string {
  return join(getPiGAgentDir(), "skills");
}

function projectSkillsDir(workspacePath: string): string {
  return join(workspacePath, ".agents", "skills");
}

function scanSkillsDir(dir: string, scope: SkillScope): ParsedSkill[] {
  if (!existsSync(dir)) return [];
  const out: ParsedSkill[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(dir, entry.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    try {
      const parsed = parseSkillFile(skillFile);
      if (!parsed) continue;
      out.push({
        id: parsed.name || entry.name,
        name: parsed.name || entry.name,
        description: parsed.description ?? "",
        path: skillFile,
        scope,
        enabled: !parsed.disableModelInvocation,
        body: parsed.body,
      });
    } catch {
      /* a half-written SKILL.md is skipped, same as pi's loader */
    }
  }
  return out;
}

function parseSkillFile(path: string): {
  name?: string;
  description?: string;
  disableModelInvocation?: boolean;
  body: string;
} | null {
  const raw = readFileSync(path, "utf8");
  if (!raw.startsWith("---")) return { body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { body: raw };
  const frontmatter = raw.slice(3, end);
  const body = raw.slice(end + 4).replace(/^\n/, "");
  const result: {
    name?: string;
    description?: string;
    disableModelInvocation?: boolean;
    body: string;
  } = { body };
  const linePattern = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/;
  for (const line of frontmatter.split("\n")) {
    const matched = line.match(linePattern);
    if (!matched) continue;
    const key = matched[1];
    const rawValue = matched[2] ?? "";
    const value = rawValue.trim().replace(/^["']|["']$/g, "");
    if (key === "name") result.name = value;
    else if (key === "description") result.description = value;
    else if (key === "disable-model-invocation") result.disableModelInvocation = value === "true";
  }
  return result;
}

export class PiSkillsService {
  async list(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<SkillsListResult> {
    const skills = [
      ...scanSkillsDir(userSkillsDir(), "user"),
      ...(params.workspacePath
        ? scanSkillsDir(projectSkillsDir(params.workspacePath), "workspace")
        : []),
    ];
    return {
      skills,
      capability: { userScopeAvailable: true },
      diagnostics: [],
    };
  }

  async setEnabled(params: {
    workspacePath: string;
    skillId: string;
    enabled: boolean;
  }): Promise<void> {
    const all = [
      ...scanSkillsDir(userSkillsDir(), "user"),
      ...(params.workspacePath
        ? scanSkillsDir(projectSkillsDir(params.workspacePath), "workspace")
        : []),
    ];
    const target =
      all.find((skill) => skill.id === params.skillId) ??
      all.find((skill) => basename(dirname(skill.path)) === params.skillId);
    if (!target) throw new Error(`skill not found: ${params.skillId}`);
    if (!existsSync(target.path)) throw new Error(`skill file missing: ${target.path}`);

    const raw = readFileSync(target.path, "utf8");
    const updated = setFrontmatterFlag(
      raw,
      "disable-model-invocation",
      params.enabled ? null : "true",
    );
    writeFileSync(target.path, updated);
  }

  async buildPromptContext(params: { prompt: string }): Promise<SkillsPromptContext> {
    // pi injects skills into the system prompt itself; the client-side prompt
    // builder has nothing to add.
    return { prompt: params.prompt, activatedSkillNames: [] };
  }

  async copyToCommon(params: { skillId: string }): Promise<{ newPath: string }> {
    const source = [...scanSkillsDir(userSkillsDir(), "user")].find(
      (skill) => skill.id === params.skillId,
    );
    if (!source) throw new Error(`skill not found: ${params.skillId}`);
    // pi has no "common" dir; user scope IS the common scope for PI.
    const destDir = join(userSkillsDir(), params.skillId);
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, "SKILL.md"), readFileSync(source.path));
    return { newPath: join(destDir, "SKILL.md") };
  }

  async removeFromCommon(params: { skillId: string }): Promise<void> {
    const dir = join(userSkillsDir(), params.skillId);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }

  async deleteSkill(params: { skillId: string; workspacePath?: string }): Promise<void> {
    const all = [
      ...scanSkillsDir(userSkillsDir(), "user"),
      ...(params.workspacePath
        ? scanSkillsDir(projectSkillsDir(params.workspacePath), "workspace")
        : []),
    ];
    const target = all.find((skill) => skill.id === params.skillId);
    if (!target) throw new Error(`skill not found: ${params.skillId}`);
    // Guard: only ever delete inside the two pi skill roots.
    const allowedRoots = [
      userSkillsDir(),
      params.workspacePath ? projectSkillsDir(params.workspacePath) : null,
    ];
    if (!allowedRoots.some((root) => root && target.path.startsWith(root))) {
      throw new Error(`refusing to delete outside pi skill roots: ${target.path}`);
    }
    rmSync(dirname(target.path), { recursive: true, force: true });
  }
}

/**
 * Set (value !== null) or remove (value === null) one frontmatter key,
 * preserving every other line byte-for-byte — the same surgical edit pi-web's
 * skill toggle performs so user formatting survives.
 */
function setFrontmatterFlag(raw: string, key: string, value: string | null): string {
  if (!raw.startsWith("---")) {
    return value === null ? raw : `---\n${key}: ${value}\n---\n\n${raw}`;
  }
  const end = raw.indexOf("\n---", 3);
  if (end === -1) {
    return value === null ? raw : `---\n${key}: ${value}\n---\n\n${raw}`;
  }
  const frontmatter = raw.slice(3, end);
  const rest = raw.slice(end);
  const lines = frontmatter.split("\n");
  const keyIndex = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (value === null) {
    if (keyIndex !== -1) lines.splice(keyIndex, 1);
  } else if (keyIndex === -1) {
    lines.push(`${key}: ${value}`);
  } else {
    lines[keyIndex] = `${key}: ${value}`;
  }
  return `---${lines.join("\n")}${rest}`;
}

export function mountPiSkillsService(
  register: (descriptor: typeof ISkillsService, instance: unknown) => void,
): void {
  register(ISkillsService, withServiceFallbacks(new PiSkillsService(), "skillsService"));
}
