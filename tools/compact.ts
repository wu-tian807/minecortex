import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition, ToolOutput } from "../src/core/types.js";
import type { LLMMessage } from "../src/llm/types.js";
import { summarizeForCompaction, repairToolPairing, microCompact } from "../src/session/compaction.js";
import { createProvider } from "../src/llm/provider.js";
import { assembleResponse } from "../src/llm/stream.js";

const SUMMARIZE_PROMPT = `You are a session compaction assistant. Your task is to create a continuation summary that allows efficient resumption of work in a new context window where the conversation history will be replaced with this summary.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts. In your analysis:
1. Chronologically walk through each message, identifying the user's requests, your approach, key decisions, and specific details (file names, code snippets, function signatures).
2. Note errors encountered and how they were resolved, especially user corrections.
3. Double-check for technical accuracy and completeness.

Then provide your structured summary in <summary> tags with these sections:

1. Task Overview
   - The user's core request and success criteria
   - Clarifications or constraints they specified

2. Current State
   - What has been completed so far
   - Files created, modified, or analyzed (with paths)
   - Key outputs or artifacts produced

3. Key Discoveries & Errors
   - Technical constraints or requirements uncovered
   - Decisions made and their rationale
   - Errors encountered and how they were resolved
   - Approaches tried that didn't work (and why)

4. User Messages
   - List all non-tool-result user messages (to preserve intent drift and feedback)

5. Pending Tasks & Next Steps
   - Specific actions needed to complete the task
   - Any blockers or open questions
   - Priority order if multiple steps remain
   - Include direct quotes from the most recent exchange showing where you left off

6. Context to Preserve
   - User preferences or style requirements
   - Domain-specific details that aren't obvious
   - Any promises made to the user

Be concise but complete — err on the side of including information that would prevent duplicate work or repeated mistakes. Write in a way that enables immediate resumption of the task.`;

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
    const brainDir = ctx.pathManager.brainDir(ctx.brainId);
    const sessionJsonPath = join(brainDir, "session.json");

    let sessionData: { currentSessionId: string; [k: string]: unknown };
    try {
      sessionData = JSON.parse(await readFile(sessionJsonPath, "utf-8"));
    } catch {
      return "No active session found.";
    }

    const oldSessionId = sessionData.currentSessionId;
    const oldMessagesPath = join(brainDir, "sessions", oldSessionId, "messages.jsonl");

    let rawContent: string;
    try {
      rawContent = await readFile(oldMessagesPath, "utf-8");
    } catch {
      return "Session messages file not found.";
    }

    const lines = rawContent.split("\n").filter(l => l.trim().length > 0);
    if (lines.length < 4) {
      return "Session too short to compact (fewer than 4 messages).";
    }

    const messages: LLMMessage[] = lines.map(l => JSON.parse(l));

    const lastUsage = [...messages].reverse().find(m => m.usage)?.usage;
    const tokensBefore = lastUsage
      ? lastUsage.inputTokens + lastUsage.outputTokens
      : 0;

    // If the last message is an assistant with unresolved tool_calls, it means compact
    // is running as part of a parallel tool batch — those results haven't been written yet.
    // Park the message so repairToolPairing doesn't add synthetic results for in-flight calls;
    // the real results will be appended to the new session after compact returns.
    const lastMsg = messages[messages.length - 1];
    const isInFlight =
      lastMsg?.role === "assistant" &&
      lastMsg.toolCalls &&
      lastMsg.toolCalls.length > 0;
    const baseMessages = isInFlight ? messages.slice(0, -1) : messages;
    const parked: LLMMessage | null = isInFlight ? lastMsg : null;

    const compacted = microCompact(baseMessages, { keepToolResults: 3, keepMedias: 2 });
    const repaired = repairToolPairing(compacted);

    let modelName: string | undefined;
    try {
      const brainJson = JSON.parse(await readFile(join(brainDir, "brain.json"), "utf-8"));
      modelName = brainJson.model as string | undefined;
      if (Array.isArray(modelName)) modelName = modelName[0];
    } catch { /* no brain.json */ }

    const customInstructions = args.instructions as string | undefined;

    let summarizer: ((msgs: LLMMessage[]) => Promise<string>) | undefined;
    if (modelName) {
      try {
        const provider = createProvider(modelName);
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
              { role: "user", content: `Conversation to summarize (${msgs.length} messages):\n\n${conversationText}` },
            ],
            [],
            ctx.signal,
          );
          const resp = await assembleResponse(stream);
          return typeof resp.content === "string" ? resp.content : "[summary generation failed]";
        };
      } catch { /* LLM unavailable */ }
    }

    const { summary, keptMessages } = await summarizeForCompaction(repaired, 0.7, summarizer);
    // Re-attach the in-flight assistant message so the real results appended after this
    // tool returns have a matching tool_use block in the new session.
    const newMessages = [summary, ...keptMessages, ...(parked ? [parked] : [])];

    const newSessionId = `s_${Date.now()}`;
    const newSessionDir = join(brainDir, "sessions", newSessionId);
    await mkdir(newSessionDir, { recursive: true });

    const newContent = newMessages.map(m => JSON.stringify(m)).join("\n") + "\n";
    await writeFile(join(newSessionDir, "messages.jsonl"), newContent, "utf-8");

    sessionData.currentSessionId = newSessionId;
    await writeFile(sessionJsonPath, JSON.stringify(sessionData, null, 2), "utf-8");

    console.log(
      `[compact] ${oldSessionId} → ${newSessionId} | msgs: ${messages.length} → ${newMessages.length}` +
      (tokensBefore ? ` | tokens before: ${tokensBefore}` : "") +
      ` | summarizer: ${summarizer ? "LLM" : "template"}`,
    );

    return `Compaction complete. Old session ${oldSessionId} preserved, now using ${newSessionId}.`;
  },
} satisfies ToolDefinition;
