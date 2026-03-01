import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition, ToolOutput } from "../src/core/types.js";
import type { LLMMessage } from "../src/llm/types.js";
import { estimateTokens } from "../src/core/token-stats.js";
import { summarizeForCompaction, repairToolPairing, microCompact } from "../src/session/compaction.js";

export default {
  name: "compact",
  description:
    "Compact the current session history to free up context window space. " +
    "Summarizes the oldest 70% of messages and keeps the newest 30% intact. " +
    "Archives the original session as a .bak file.",
  input_schema: {
    type: "object",
    properties: {},
    required: [],
  },
  async execute(_args, ctx): Promise<ToolOutput> {
    const sessionJsonPath = join(ctx.pathManager.brainDir(ctx.brainId), "session.json");
    let currentSessionId: string;
    try {
      const raw = await readFile(sessionJsonPath, "utf-8");
      const data = JSON.parse(raw);
      currentSessionId = data.currentSessionId;
    } catch {
      return "No active session found.";
    }

    const messagesPath = join(
      ctx.pathManager.brainDir(ctx.brainId),
      "sessions",
      currentSessionId,
      "messages.jsonl",
    );

    let rawContent: string;
    try {
      rawContent = await readFile(messagesPath, "utf-8");
    } catch {
      return "Session messages file not found.";
    }

    const lines = rawContent.split("\n").filter(l => l.trim().length > 0);
    if (lines.length < 4) {
      return "Session too short to compact (fewer than 4 messages).";
    }

    const messages: LLMMessage[] = lines.map(l => JSON.parse(l));

    const tokensBefore = messages.reduce(
      (sum, m) => sum + estimateTokens(m.content),
      0,
    );

    const compacted = microCompact(messages, { keepToolResults: 3, keepMedias: 2 });
    const repaired = repairToolPairing(compacted);
    const { summary, keptMessages } = summarizeForCompaction(repaired);

    const summaryTokens = estimateTokens(summary.content);

    const newMessages = [summary, ...keptMessages];
    const tokensAfter = newMessages.reduce(
      (sum, m) => sum + estimateTokens(m.content),
      0,
    );

    const bakPath = messagesPath + ".bak";
    await rename(messagesPath, bakPath);

    const newContent = newMessages.map(m => JSON.stringify(m)).join("\n") + "\n";
    await writeFile(messagesPath, newContent, "utf-8");

    ctx.brainBoard.set(ctx.brainId, "tokens.lastInputTokens", tokensAfter);

    return [
      `Compaction complete.`,
      `  Messages: ${messages.length} → ${newMessages.length}`,
      `  Tokens (est): ${tokensBefore} → ${tokensAfter}`,
      `  Summary tokens: ${summaryTokens}`,
      `  Original archived: ${bakPath}`,
    ].join("\n");
  },
} satisfies ToolDefinition;
