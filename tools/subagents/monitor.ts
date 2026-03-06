import type { SessionManager } from "../../src/session/session-manager.js";
import type { LLMMessage } from "../../src/llm/types.js";
import { SUBAGENT_QUESTION_MARKER } from "./types.js";
import { serializeContent } from "./context.js";

const POLL_INTERVAL_MS = 300;

export type SubagentOutcome =
  | { status: "completed"; result: string }
  | { status: "question"; question: string }
  | { status: "error"; error: string };

export async function waitForSubagentCompletion(opts: {
  scheduler: {
    controlBrain(action: string, target?: string): Promise<string> | string;
  };
  sessionManager: SessionManager;
  subagentId: string;
  signal?: AbortSignal;
}): Promise<SubagentOutcome> {
  const { scheduler, sessionManager, subagentId, signal } = opts;

  for (;;) {
    if (signal?.aborted) {
      await Promise.resolve(scheduler.controlBrain("stop", subagentId)).catch(() => {});
      return { status: "error", error: "Subagent interrupted by parent turn." };
    }

    const messages = await sessionManager.loadSession();
    const outcome = pickSubagentOutcome(messages);
    if (outcome) return outcome;

    await sleep(POLL_INTERVAL_MS);
  }
}

export function pickSubagentOutcome(messages: LLMMessage[]): SubagentOutcome | null {
  if (messages.length === 0) return null;
  const last = messages[messages.length - 1];
  if (last.role !== "assistant") return null;
  if (last.toolCalls && last.toolCalls.length > 0) return null;

  const text = serializeContent(last.content);
  const question = parseQuestionMarker(text);
  if (question) return { status: "question", question };

  return {
    status: "completed",
    result: text || "[subagent completed but produced no text summary]",
  };
}

function parseQuestionMarker(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(SUBAGENT_QUESTION_MARKER)) return null;
  const question = trimmed.slice(SUBAGENT_QUESTION_MARKER.length).trim();
  return question || "Subagent requested input.";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
