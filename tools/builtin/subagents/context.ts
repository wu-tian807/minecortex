import type { ToolContext } from "../../../src/core/types.js";
import type { LLMMessage } from "../../../src/llm/types.js";
import { SessionManager } from "../../../src/session/session-manager.js";
import type { ContextMode } from "./types.js";

export async function buildInitialPrompt(
  ctx: ToolContext,
  task: string,
  contextMode: ContextMode,
): Promise<string> {
  if (contextMode === "none") return task;

  const sessionManager = new SessionManager(ctx.brainId, ctx.pathManager);
  const history = await sessionManager.loadPromptHistory({ keepToolResults: 4 });
  const contextText = renderParentContext(history, contextMode);
  if (!contextText) return task;

  return [
    "Primary task:",
    task,
    "",
    "Parent context for reference:",
    contextText,
  ].join("\n");
}

export function renderParentContext(history: LLMMessage[], contextMode: ContextMode): string {
  const maxMessages = contextMode === "summary" ? 8 : 20;
  const maxChars = contextMode === "summary" ? 6000 : 16000;

  const relevant = history
    .filter((msg) => msg.role !== "tool")
    .slice(-maxMessages)
    .map((msg) => `[${msg.role}] ${serializeContent(msg.content)}`)
    .filter((line) => line.trim().length > 0);

  if (relevant.length === 0) return "";

  let text = relevant.join("\n\n");
  if (text.length > maxChars) {
    text = `[truncated]\n${text.slice(text.length - maxChars)}`;
  }
  return text;
}

export function serializeContent(content: LLMMessage["content"]): string {
  if (typeof content === "string") {
    return stripThinking(content).replace(/\s+/g, " ").trim();
  }
  try {
    return JSON.stringify(content);
  } catch {
    return "[unserializable content]";
  }
}

function stripThinking(text: string): string {
  return text.replace(/<thinking>[\s\S]*?<\/thinking>\n?/g, "").trim();
}
