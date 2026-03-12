import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ToolDefinition, ToolOutput } from "../../src/core/types.js";
import type { LLMMessage } from "../../src/llm/types.js";
import { summarizeForCompaction, microCompact } from "../../src/session/compaction.js";
import { repairToolPairing } from "../../src/session/history-normalizer.js";
import { createProvider } from "../../src/llm/provider.js";
import { assembleResponse } from "../../src/llm/stream.js";

const SUMMARIZE_PROMPT = `You are a session compaction assistant. Create a concise continuation summary so work can resume immediately in a new context window.

Output ONLY the summary text — no preamble, no analysis block, no XML tags.

Structure it with these sections (plain markdown headings):

## Task Overview
One or two sentences: what the user asked for and the success criteria.

## Current State
Bullet list of what is done, files created/modified (with paths), key outputs.

## Key Decisions & Errors
Only notable: decisions made, errors encountered and how resolved, dead ends.

## User Messages (verbatim)
Short verbatim quotes of the user's non-tool messages that capture intent drift or corrections.

## Pending Tasks
Ordered list of remaining actions. Quote the last exchange to show where we left off.

## Context to Preserve
User preferences, domain quirks, promises made.

Be as brief as possible — aim for under 600 words total. Every sentence must earn its place.`;
export default {
  name: "compact",
  description:
    "Compact the current session by summarizing old messages into a new session. " +
    "The original session is preserved intact. A new session is created with " +
    "the summary + newest 30% of messages, and the session pointer is switched.",
  input_schema: {
    type: "object",
    properties: {
      instructions: {
        type: "string",
        description: "Custom instructions for the summarizer, e.g. 'Focus on game state and bot actions'",
      },
    },
    required: [],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const sessionManager = ctx.sessionManager;
    if (!sessionManager) return "Session manager unavailable.";

    const brainDir = ctx.pathManager.local(ctx.brainId).root();
    const sessionJsonPath = join(brainDir, "session.json");

    // Read session.json once to get current session ID and any extra metadata to preserve.
    let sessionData: { currentSessionId: string; [k: string]: unknown };
    try {
      sessionData = JSON.parse(await readFile(sessionJsonPath, "utf-8"));
    } catch {
      return "No active session found.";
    }

    const oldSessionId = sessionData.currentSessionId;
    const snapshot = await sessionManager.loadSnapshot(oldSessionId);
    if (!snapshot) {
      return "Session messages file not found.";
    }

    const messages = snapshot.messages as LLMMessage[];
    if (messages.length < 4) {
      return "Session too short to compact (fewer than 4 messages).";
    }

    const lastUsage = [...messages].reverse().find(m => m.usage)?.usage;
    const tokensBefore = lastUsage
      ? lastUsage.inputTokens + lastUsage.outputTokens
      : 0;

    // Detect in-flight tool calls that haven't received a result yet.
    //
    // Two layouts are possible depending on when compact runs:
    //   A) last = assistant + toolCalls          (parallel batch, no pending written yet)
    //   B) last = [Pending: …] tool message      (sequential: appendToolPendings already ran)
    //
    // In both cases we park the assistant message so repairToolPairing won't generate
    // a synthetic error — the real result will be appended to the new session after
    // compact returns.
    const lastMsg = messages[messages.length - 1];
    const secondLastMsg = messages[messages.length - 2];

    let baseMessages: LLMMessage[];
    let parked: LLMMessage | null;

    if (lastMsg?.role === "assistant" && lastMsg.toolCalls?.length) {
      // Layout A
      baseMessages = messages.slice(0, -1);
      parked = lastMsg;
    } else if (
      lastMsg?.role === "tool" && lastMsg.toolStatus === "pending" &&
      secondLastMsg?.role === "assistant" && secondLastMsg.toolCalls?.length
    ) {
      // Layout B — drop the pending placeholder too; the real result replaces it
      baseMessages = messages.slice(0, -2);
      parked = secondLastMsg;
    } else {
      baseMessages = messages;
      parked = null;
    }

    const compacted = microCompact(baseMessages, { keepToolResults: 3, keepMedias: 2 });
    const repaired = repairToolPairing(compacted);

    let modelName: string | undefined;
    try {
      const brainJson = ctx.getBrainJson();
      const configuredModel = brainJson.models?.model;
      modelName = Array.isArray(configuredModel) ? configuredModel[0] : configuredModel;
    } catch { /* no brain config */ }

    const customInstructions = args.instructions as string | undefined;

    // Capture the summarize LLM call's usage so we can stamp it onto the new session's
    // last message — giving lastUsageFrom() a compact-specific estimate instead of
    // the stale pre-compact value from keptMessages.
    let summarizeUsage: { inputTokens: number; outputTokens: number } | undefined;

    let summarizer: ((msgs: LLMMessage[]) => Promise<string>) | undefined;
    if (modelName) {
      try {
        const provider = createProvider(modelName, {
            maxTokens: 1500,   // summary 控制在 ~1000 words 以内，避免无限生成
            showThinking: false, // 关闭 extended thinking，避免额外 token 消耗
            temperature: 0.3,
          });
        summarizer = async (msgs: LLMMessage[]) => {
          const conversationText = msgs
            .map(m => {
              const text = typeof m.content === "string" ? m.content : "[multimodal]";
              return `[${m.role}] ${text.slice(0, 500)}`;
            })
            .join("\n");

          let systemPrompt = SUMMARIZE_PROMPT;
          if (customInstructions) {
            systemPrompt += `\n\n## Custom Compact Instructions\n${customInstructions}`;
          }

          const stream = provider.chatStream(
            [
              { role: "system", content: systemPrompt },
              {
                role: "user",
                content:
                  `Below is a conversation history (${msgs.length} messages) that needs to be summarized. ` +
                  `Write a natural-language continuation summary following your system instructions. ` +
                  `Do NOT reproduce or reformat the conversation — synthesize what happened in your own words.\n\n` +
                  `--- Conversation History ---\n${conversationText}\n--- End ---`,
              },
            ],
            [],
            ctx.signal,
          );
          const resp = await assembleResponse(stream);
          if (resp.usage) {
            summarizeUsage = { inputTokens: resp.usage.inputTokens, outputTokens: resp.usage.outputTokens };
          }
          return typeof resp.content === "string" ? resp.content : "[summary generation failed]";
        };
      } catch { /* LLM unavailable */ }
    }

    const { summary, keptMessages } = await summarizeForCompaction(repaired, 0.7, summarizer);
    // Re-attach the in-flight assistant message so the real results appended after this
    // tool returns have a matching tool_use block in the new session.
    const newMessages = [summary, ...keptMessages, ...(parked ? [parked] : [])];

    // Stamp the summarize usage onto the last message of the new session.
    // This gives lastUsageFrom() a meaningful compact-time estimate so the status-bar
    // ring shows a sensible value immediately after compact (instead of the old
    // pre-compact value from keptMessages or null for brand-new sessions).
    if (summarizeUsage && newMessages.length > 0) {
      const last = newMessages[newMessages.length - 1];
      newMessages[newMessages.length - 1] = { ...last, usage: summarizeUsage };
    }

    const newSessionId = await sessionManager.newSession(newMessages);

    // Restore any extra metadata (e.g. responseApi) that newSession doesn't carry over.
    // currentSessionId is already correct; strip it to avoid overwriting what newSession wrote.
    const { currentSessionId: _old, ...extraMeta } = sessionData;
    if (Object.keys(extraMeta).length > 0) {
      await sessionManager.updateSessionMeta(extraMeta);
    }

    console.log(
      `[compact] ${oldSessionId} → ${newSessionId} | msgs: ${messages.length} → ${newMessages.length}` +
      (tokensBefore ? ` | tokens before: ${tokensBefore}` : "") +
      (summarizeUsage ? ` | tokens after: ${summarizeUsage.inputTokens + summarizeUsage.outputTokens}` : "") +
      ` | summarizer: ${summarizer ? "LLM" : "template"}`,
    );

    return `Compaction complete. Old session ${oldSessionId} preserved, now using ${newSessionId}.`;
  },
} satisfies ToolDefinition;
