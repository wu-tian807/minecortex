import { dirname, basename, join, relative } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import YAML from "yaml";
import type { ContextSlot } from "../../src/context/types.js";
import type { PathManagerAPI } from "../../src/core/types.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

interface SkillFrontmatter {
  name?: unknown;
  description?: unknown;
  [key: string]: unknown;
}

interface SkillIndexItem {
  name: string;
  description: string;
  filePath: string;
}

interface SkillDocument {
  name: string;
  description: string;
  filePath: string;
  content: string;
  references: string[];
  scripts: string[];
  assets: string[];
}

const warnedOverrides = new Set<string>();

function skillDirs(pm: PathManagerAPI, brainId: string): string[] {
  return [
    join(pm.global().root(), "skills"),
    join(pm.bundle().root(), "skills"),
    join(pm.local(brainId).root(), "skills"),
  ];
}

function discoverSkills(pm: PathManagerAPI, brainId: string): SkillIndexItem[] {
  const map = new Map<string, SkillIndexItem>();

  for (const dir of skillDirs(pm, brainId)) {
    for (const filePath of discoverSkillFiles(dir)) {
      const skill = parseSkillIndex(filePath);
      if (!skill) continue;
      const previous = map.get(skill.name);
      if (previous && !warnedOverrides.has(`${previous.filePath}->${skill.filePath}`)) {
        warnedOverrides.add(`${previous.filePath}->${skill.filePath}`);
        console.warn(
          `[skills-loader] skill "${skill.name}" overridden: ${relative(pm.root(), previous.filePath)} -> ${relative(pm.root(), skill.filePath)}`,
        );
      }
      map.set(skill.name, skill);
    }
  }

  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function loadSkillByName(pm: PathManagerAPI, brainId: string, name: string): SkillDocument | null {
  const skill = discoverSkills(pm, brainId).find((entry) => entry.name === name);
  if (!skill) return null;
  return readSkillDocument(skill);
}

export function createSkillsSummarySlot(pm: PathManagerAPI, brainId: string): ContextSlot {
  return {
    id: "skills",
    order: 40,
    priority: 7,
    content: () => {
      const skills = discoverSkills(pm, brainId);
      if (skills.length === 0) return "";
      const lines = ["## Available Skills"];
      for (const skill of skills) {
        lines.push(`- ${skill.name}: ${skill.description}`);
      }
      lines.push(
        "",
        "IMPORTANT: When a task matches a skill, you MUST call read_skill first to get detailed instructions before proceeding.",
        "If the skill references supporting files under references/, scripts/, or assets/, use the standard read_file tool to inspect them on demand.",
      );
      return lines.join("\n");
    },
    version: 0,
  };
}

function parseSkillIndex(path: string): SkillIndexItem | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const { frontmatter, body } = splitSkillFile(raw);
    const name = asNonEmptyString(frontmatter.name) ?? basename(dirname(path));
    const description = asNonEmptyString(frontmatter.description) ?? deriveDescription(body);

    return {
      name,
      description,
      filePath: path,
    };
  } catch {
    return null;
  }
}

function readSkillDocument(skill: SkillIndexItem): SkillDocument {
  const raw = readFileSync(skill.filePath, "utf-8");
  const { body } = splitSkillFile(raw);
  const rootDir = dirname(skill.filePath);

  return {
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    content: body,
    references: listFiles(join(rootDir, "references")).map((entry) => join(rootDir, "references", entry)),
    scripts: listFiles(join(rootDir, "scripts")).map((entry) => join(rootDir, "scripts", entry)),
    assets: listFiles(join(rootDir, "assets")).map((entry) => join(rootDir, "assets", entry)),
  };
}

function discoverSkillFiles(dir: string): string[] {
  const discovered: string[] = [];
  walkDir(dir, discovered);
  return discovered.sort((a, b) => a.localeCompare(b));
}

function walkDir(dir: string, discovered: string[]): void {
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath, discovered);
        continue;
      }
      if (entry.isFile() && entry.name === "SKILL.md") {
        discovered.push(fullPath);
      }
    }
  } catch {
    // Ignore missing or unreadable directories.
  }
}

function splitSkillFile(raw: string): { frontmatter: SkillFrontmatter; body: string } {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: {}, body: raw.trim() };

  try {
    const parsed = YAML.parse(match[1]) ?? {};
    return {
      frontmatter: isRecord(parsed) ? parsed as SkillFrontmatter : {},
      body: raw.slice(match[0].length).trim(),
    };
  } catch {
    return { frontmatter: {}, body: raw.slice(match[0].length).trim() };
  }
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  walkResourceDir(dir, dir, files);
  return files.sort((a, b) => a.localeCompare(b));
}

function walkResourceDir(root: string, dir: string, files: string[]): void {
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkResourceDir(root, fullPath, files);
        continue;
      }
      if (entry.isFile()) {
        files.push(relative(root, fullPath).replace(/\\/g, "/"));
      }
    }
  } catch {
    // Ignore missing or unreadable directories.
  }
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function deriveDescription(body: string): string {
  const paragraph = body
    .split(/\r?\n\r?\n/)
    .map((entry) => entry.replace(/\r?\n/g, " ").trim())
    .find(Boolean);
  return paragraph ?? "No description provided.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
