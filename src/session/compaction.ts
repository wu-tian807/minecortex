import type { LLMMessage, LLMToolCall } from "../llm/types.js";
import type { ContentPart } from "../core/types.js";
import { estimateTokens } from "../core/token-stats.js";

interface MicroCompactConfig {
  keepToolResults?: number;  // keep last N tool results intact
  keepMedias?: number;       // keep last N media messages intact
}

/**
 * Replace old tool_results with compact placeholders and strip old media.
 * Keeps the most recent `keepToolResults` / `keepMedias` intact.
 */
export function microCompact(messages: LLMMessage[], config: MicroCompactConfig = {}): LLMMessage[] {
  const keepTool = config.keepToolResults ?? 3;
  const keepMedia = config.keepMedias ?? 2;

  const toolIndices: number[] = [];
  const mediaIndices: number[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "tool") toolIndices.push(i);
    if (Array.isArray(msg.content) && msg.content.some(p => p.type === "image")) {
      mediaIndices.push(i);
    }
  }

  const oldToolIndices = new Set(toolIndices.slice(0, Math.max(0, toolIndices.length - keepTool)));
  const oldMediaIndices = new Set(mediaIndices.slice(0, Math.max(0, mediaIndices.length - keepMedia)));

  return messages.map((msg, i) => {
    if (oldToolIndices.has(i) && msg.role === "tool") {
      const toolName = findToolName(messages, msg.toolCallId);
      return {
        ...msg,
        content: `[Previous: used ${toolName}]`,
        truncated: true,
      };
    }

    if (oldMediaIndices.has(i) && Array.isArray(msg.content)) {
      const filtered: ContentPart[] = msg.content.map(p =>
        p.type === "image" ? { type: "text" as const, text: "[image removed for compaction]" } : p,
      );
      return { ...msg, content: filtered, truncated: true };
    }

    return msg;
  });
}

/**
 * Repair tool call / tool result pairing issues:
 * - Remove orphaned tool results (no matching tool_call)
 * - Add synthetic error result for orphaned tool_calls
 */
export function repairToolPairing(messages: LLMMessage[]): LLMMessage[] {
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) toolCallIds.add(tc.id);
    }
    if (msg.role === "tool" && msg.toolCallId) {
      toolResultIds.add(msg.toolCallId);
    }
  }

  const result: LLMMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "tool" && msg.toolCallId && !toolCallIds.has(msg.toolCallId)) {
      continue; // orphaned tool result
    }
    result.push(msg);

    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (!toolResultIds.has(tc.id)) {
          result.push({
            role: "tool",
            content: `[Error: tool call "${tc.name}" was interrupted — no result available]`,
            toolCallId: tc.id,
          });
          toolResultIds.add(tc.id);
        }
      }
    }
  }

  return result;
}

/**
 * Generate a structured summary for compaction.
 * Summarizes the oldest `ratio` portion of messages.
 */
export function summarizeForCompaction(
  messages: LLMMessage[],
  ratio = 0.7,
): { summary: LLMMessage; keptMessages: LLMMessage[] } {
  const splitIdx = Math.max(1, Math.floor(messages.length * ratio));

  let toSummarize = messages.slice(0, splitIdx);
  let kept = messages.slice(splitIdx);

  // Never split in the middle of a tool call / tool result pair
  while (kept.length > 0 && kept[0].role === "tool") {
    toSummarize.push(kept.shift()!);
  }

  const tasks: string[] = [];
  const discoveries: string[] = [];
  const toolsUsed: string[] = [];
  let lastUserMessage = "";

  for (const msg of toSummarize) {
    if (msg.role === "user") {
      const text = extractText(msg.content);
      if (text) lastUserMessage = text;
      if (text && !tasks.includes(text.slice(0, 120))) {
        tasks.push(text.slice(0, 120));
      }
    }
    if (msg.role === "assistant") {
      const text = extractText(msg.content);
      if (text && text.length > 30) {
        discoveries.push(text.slice(0, 200));
      }
    }
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (!toolsUsed.includes(tc.name)) toolsUsed.push(tc.name);
      }
    }
  }

  const keptText = kept.length > 0 ? extractText(kept[0].content) : "";

  const summaryText = [
    "# Compacted Session Summary",
    "",
    "## Task Overview",
    tasks.length > 0 ? tasks.map(t => `- ${t}`).join("\n") : "- (general conversation)",
    "",
    "## Current State",
    `- Last user request: ${lastUserMessage.slice(0, 200) || "(none)"}`,
    `- Messages compacted: ${toSummarize.length}`,
    `- Messages remaining: ${kept.length}`,
    "",
    "## Key Discoveries",
    discoveries.length > 0
      ? discoveries.slice(-5).map(d => `- ${d}`).join("\n")
      : "- (none recorded)",
    "",
    "## Tools Used",
    toolsUsed.length > 0 ? toolsUsed.map(t => `- ${t}`).join("\n") : "- (none)",
    "",
    "## Context to Preserve",
    `- Continue from where the conversation left off`,
    keptText ? `- Next context: ${keptText.slice(0, 150)}` : "",
  ].join("\n");

  const summary: LLMMessage = {
    role: "user",
    content: summaryText,
    ts: Date.now(),
  };

  return { summary, keptMessages: kept };
}

function extractText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map(p => p.text)
    .join(" ");
}

function findToolName(messages: LLMMessage[], toolCallId?: string): string {
  if (!toolCallId) return "unknown_tool";
  for (const msg of messages) {
    if (msg.toolCalls) {
      const tc = msg.toolCalls.find(t => t.id === toolCallId);
      if (tc) return tc.name;
    }
  }
  return "unknown_tool";
}
