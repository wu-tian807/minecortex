import type { BrainJson } from "../../src/core/types.js";
import type { SubagentEffort, SubagentMode, SubagentType } from "./types.js";

export interface SubagentDefaults {
  readOnly: boolean;
  tools: string[];
  defaultMode: SubagentMode;
  defaultEffort: SubagentEffort;
}

export const RESERVED_TOOLS = new Set(["manage_brain", "subagent"]);

export const SUBAGENT_DEFAULTS: Record<SubagentType, SubagentDefaults> = {
  observe: {
    readOnly: true,
    tools: ["read_file", "glob", "grep", "shell", "list_dir"],
    defaultMode: "foreground",
    defaultEffort: "low",
  },
  plan: {
    readOnly: true,
    tools: ["read_file", "glob", "grep", "shell", "list_dir", "todo_write", "write_plan"],
    defaultMode: "foreground",
    defaultEffort: "medium",
  },
  act: {
    readOnly: false,
    tools: [],
    defaultMode: "foreground",
    defaultEffort: "medium",
  },
};

export const RECURSION_RULES: Record<SubagentType, SubagentType[]> = {
  observe: [],
  plan: ["observe"],
  act: ["observe"],
};

export function isSubagentType(value: string): value is SubagentType {
  return value === "observe" || value === "plan" || value === "act";
}

export function isSubagentMode(value: string): value is SubagentMode {
  return value === "foreground" || value === "background";
}

export function isSubagentEffort(value: string): value is SubagentEffort {
  return value === "low" || value === "medium" || value === "high";
}

export function resolveSubagentMode(
  type: SubagentType,
  requested?: string,
): SubagentMode | null {
  if (!requested) return SUBAGENT_DEFAULTS[type].defaultMode;
  return isSubagentMode(requested) ? requested : null;
}

export function buildToolsSelector(
  type: SubagentType,
): BrainJson["tools"] {
  if (type !== "act") {
    return {
      global: "none",
      enable: SUBAGENT_DEFAULTS[type].tools.filter((name) => !RESERVED_TOOLS.has(name)),
    };
  }
  return { global: "all", disable: [...RESERVED_TOOLS] };
}
