import type { ContextSlot, SlotFactory } from "../src/context/types.js";

const BOARD_KEY = "subagents.actives";
const SLOT_ORDER = 55;
const SLOT_PRIORITY = 8;

type SubagentType = "observe" | "plan" | "act";

type ActiveSubagentEntry = {
  id: string;
  type: SubagentType;
  request: string;
  startedAt: string;
};

const TYPE_LABEL: Record<SubagentType, string> = {
  observe: "observe",
  plan: "plan",
  act: "act",
};

function renderSubagents(items: ActiveSubagentEntry[]): string {
  if (items.length === 0) return "";
  const lines = items.map((item) => {
    const request = item.request.replace(/\s+/g, " ").trim();
    const summary = request ? ` - ${request.slice(0, 80)}` : "";
    return `  - [${TYPE_LABEL[item.type]}] ${item.id}${summary} (${item.startedAt})`;
  });
  return `## Active Subagents (${items.length})\n\n${lines.join("\n")}\n`;
}

function isSubagentType(value: unknown): value is SubagentType {
  return value === "observe" || value === "plan" || value === "act";
}

function isActiveSubagentEntry(value: unknown): value is ActiveSubagentEntry {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string"
    && isSubagentType(item.type)
    && typeof item.request === "string"
    && typeof item.startedAt === "string";
}

function readEntries(brainBoard: { get(brainId: string, key: string): unknown }, brainId: string): ActiveSubagentEntry[] {
  const value = brainBoard.get(brainId, BOARD_KEY);
  if (!Array.isArray(value)) return [];
  return value.filter(isActiveSubagentEntry);
}

const create: SlotFactory = (ctx): ContextSlot => {
  const { brainId, brainBoard } = ctx;

  return {
    id: "subagents",
    order: SLOT_ORDER,
    priority: SLOT_PRIORITY,
    condition: () => readEntries(brainBoard, brainId).length > 0,
    content: () => renderSubagents(readEntries(brainBoard, brainId)),
    version: 0,
  };
};

export default create;
