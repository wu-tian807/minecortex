/** @desc ContextEngine — 分层组装 LLM System Prompt: Soul → State → Events → Tools → Directives */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ToolDefinition,
  Event,
  LLMMessage,
  BrainJson,
  DirectiveContext,
} from "../core/types.js";
import { loadDirectives } from "../loaders/directive-loader.js";

const ROOT = process.cwd();

export interface ContextInput {
  brainId: string;
  model: string;
  events: Event[];
  tools: ToolDefinition[];
  sessionHistory: LLMMessage[];
  brainConfig: BrainJson;
}

function renderEventDisplay(event: Event): string {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (payload?.prompt && typeof payload.prompt === "string") {
    return payload.prompt;
  }
  if (payload?.content && typeof payload.content === "string") {
    const summary = (payload as any).summary;
    return summary ? `${summary}: ${payload.content}` : String(payload.content);
  }
  return JSON.stringify(event.payload);
}

export async function assemblePrompt(input: ContextInput): Promise<LLMMessage[]> {
  const { brainId, model, events, tools, sessionHistory, brainConfig } = input;
  const brainDir = join(ROOT, "brains", brainId);

  // Layer 1: Soul
  let soul = "";
  try {
    soul = await readFile(join(brainDir, "soul.md"), "utf-8");
  } catch { /* no soul.md */ }

  // Layer 2: State
  let state: Record<string, unknown> = {};
  try {
    state = JSON.parse(await readFile(join(brainDir, "state.json"), "utf-8"));
  } catch { /* empty state */ }

  // Layer 3: Events — grouped by source
  const runtimeLines: string[] = [];
  if (events.length > 0) {
    const grouped = new Map<string, Event[]>();
    for (const e of events) {
      const list = grouped.get(e.source) ?? [];
      list.push(e);
      grouped.set(e.source, list);
    }

    for (const [source, evts] of grouped) {
      runtimeLines.push(`## 来自 ${source}`);
      for (const e of evts) {
        runtimeLines.push(`- [${e.type}] ${renderEventDisplay(e)}`);
      }
    }
  }

  // Layer 4: Tool descriptions
  const toolLines: string[] = [];
  if (tools.length > 0) {
    toolLines.push("## 可用工具");
    for (const t of tools) {
      const params = Object.entries(t.parameters)
        .map(([k, v]) => `${k}(${v.type}${v.required !== false ? ", required" : ""})`)
        .join(", ");
      toolLines.push(`- **${t.name}**: ${t.description} [${params}]`);
    }
  }

  // Layer 5: Directives (loaded from files, condition-filtered, ordered)
  const directiveCtx: DirectiveContext = {
    brainId,
    hasTools: tools.length > 0,
    hasSubscriptions: !!brainConfig.subscriptions?.enable?.length,
  };
  const directiveVars: Record<string, string> = {
    BRAIN_ID: brainId,
    MODEL: model,
    TIMESTAMP: new Date().toISOString(),
  };
  const directivesBlock = await loadDirectives(brainId, brainConfig, directiveCtx, directiveVars);

  // Assemble system prompt
  const systemParts = [
    soul,
    "",
    `## 当前状态\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\``,
    "",
    runtimeLines.join("\n"),
    "",
    toolLines.join("\n"),
    "",
    directivesBlock,
  ].filter(Boolean);

  const systemPrompt = systemParts.join("\n");

  // Build messages array
  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    ...sessionHistory,
  ];

  // Construct user message from drained events
  if (events.length > 0) {
    const parts: string[] = [];
    for (const e of events) {
      parts.push(`[${e.source}:${e.type}] ${renderEventDisplay(e)}`);
    }
    messages.push({
      role: "user",
      content: parts.join("\n"),
    });
  }

  return messages;
}
