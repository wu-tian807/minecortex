import type { LLMMessage, LLMToolCall } from "../llm/types.js";
import type { ContentPart } from "../core/types.js";
import { estimateTokens } from "../core/token-stats.js";
import { BRAIN_DEFAULTS } from "../defaults/brain-defaults.js";

interface MicroCompactConfig {
  keepToolResults?: number;  // keep last N tool results intact
  keepMedias?: number;       // keep last N media messages intact
}

/**
 * Replace old tool_results with compact placeholders and strip old media.
 * Keeps the most recent `keepToolResults` / `keepMedias` intact.
 */
export function microCompact(messages: LLMMessage[], config: MicroCompactConfig = {}): LLMMessage[] {
  const keepTool = config.keepToolResults ?? BRAIN_DEFAULTS.session.keepToolResults;
  const keepMedia = config.keepMedias ?? BRAIN_DEFAULTS.session.keepMedias;

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

export type LLMSummarizer = (messages: LLMMessage[]) => Promise<string>;

/**
 * Split messages at `ratio`, then generate a summary for the older portion.
 * When `summarizer` is provided, uses LLM for real summarization.
 * Falls back to a mechanical template extraction when no summarizer is given.
 */
export async function summarizeForCompaction(
  messages: LLMMessage[],
  ratio = 0.7,
  summarizer?: LLMSummarizer,
): Promise<{ summary: LLMMessage; keptMessages: LLMMessage[] }> {
  const splitIdx = Math.max(1, Math.floor(messages.length * ratio));

  const toSummarize = messages.slice(0, splitIdx);
  const kept = messages.slice(splitIdx);

  while (kept.length > 0 && kept[0].role === "tool") {
    toSummarize.push(kept.shift()!);
  }

  let summaryText: string;

  if (summarizer) {
    summaryText = await summarizer(toSummarize);
  } else {
    summaryText = templateSummary(toSummarize, kept);
  }

  const summary: LLMMessage = {
    role: "user",
    content: summaryText,
    ts: Date.now(),
  };

  return { summary, keptMessages: kept };
}

function templateSummary(toSummarize: LLMMessage[], kept: LLMMessage[]): string {
  const tasks: string[] = [];
  const discoveries: string[] = [];
  const toolsUsed: string[] = [];
  const userMessages: string[] = [];
  const errors: string[] = [];
  let lastUserMessage = "";

  for (const msg of toSummarize) {
    const text = extractText(msg.content);

    if (msg.role === "user") {
      if (text) lastUserMessage = text;
      if (text && !tasks.includes(text.slice(0, 120))) {
        tasks.push(text.slice(0, 120));
      }
      if (text) userMessages.push(text.slice(0, 200));
    }

    if (msg.role === "assistant") {
      if (text && text.length > 30) {
        discoveries.push(text.slice(0, 200));
      }
    }

    if (msg.role === "tool" && text) {
      const lower = text.toLowerCase();
      if (lower.includes("error") || lower.includes("fail") || lower.includes("exception")) {
        errors.push(text.slice(0, 200));
      }
    }

    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (!toolsUsed.includes(tc.name)) toolsUsed.push(tc.name);
      }
    }
  }

  const keptText = kept.length > 0 ? extractText(kept[0].content) : "";

  return [
    "# Compacted Session Summary",
    "",
    "## Task Overview",
    tasks.length > 0 ? tasks.map(t => `- ${t}`).join("\n") : "- (general conversation)",
    "",
    "## Current State",
    `- Last user request: ${lastUserMessage.slice(0, 300) || "(none)"}`,
    `- Messages compacted: ${toSummarize.length}`,
    `- Messages remaining: ${kept.length}`,
    "",
    "## Key Discoveries & Errors",
    discoveries.length > 0
      ? discoveries.slice(-5).map(d => `- ${d}`).join("\n")
      : "- (none recorded)",
    errors.length > 0
      ? "\n### Errors Encountered\n" + errors.slice(-5).map(e => `- ${e}`).join("\n")
      : "",
    "",
    "## User Messages",
    userMessages.length > 0
      ? userMessages.slice(-8).map(m => `- ${m}`).join("\n")
      : "- (none)",
    "",
    "## Tools Used",
    toolsUsed.length > 0 ? toolsUsed.map(t => `- ${t}`).join("\n") : "- (none)",
    "",
    "## Pending Tasks & Next Steps",
    `- Continue from: ${lastUserMessage.slice(0, 200) || "(conversation end)"}`,
    keptText ? `- Next context: ${keptText.slice(0, 200)}` : "",
    "",
    "## Context to Preserve",
    `- Session had ${toSummarize.length + kept.length} total messages`,
    toolsUsed.length > 0 ? `- Active tool set: ${toolsUsed.join(", ")}` : "",
  ].join("\n");
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
