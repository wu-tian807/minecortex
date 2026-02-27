/** @desc ContextEngine — 分层组装 LLM System Prompt: Soul → State → Notices → Tools → Directives */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ToolDefinition,
  Notice,
  LLMMessage,
  BrainJson,
  DirectiveContext,
} from "../core/types.js";
import { loadDirectives } from "../loaders/directive-loader.js";

const ROOT = process.cwd();

export interface ContextInput {
  brainId: string;
  model: string;
  notices: Notice[];
  tools: ToolDefinition[];
  sessionHistory: LLMMessage[];
  brainConfig: BrainJson;
}

export async function assemblePrompt(input: ContextInput): Promise<LLMMessage[]> {
  const { brainId, model, notices, tools, sessionHistory, brainConfig } = input;
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

  // Layer 3: Notices
  const runtimeLines: string[] = [];
  const eventNotices = notices.filter((n) => n.kind === "event" && n.event);
  const busNotices = notices.filter((n) => n.kind === "bus" && n.message);

  if (eventNotices.length > 0) {
    runtimeLines.push("## 收到的事件");
    for (const n of eventNotices) {
      const e = n.event!;
      runtimeLines.push(`- [${e.source}] ${e.type}: ${JSON.stringify(e.payload)}`);
    }
  }

  if (busNotices.length > 0) {
    runtimeLines.push("## 收到的脑间消息");
    for (const n of busNotices) {
      const m = n.message!;
      runtimeLines.push(`- [${m.from}] ${m.summary}: ${m.content}`);
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

  // Construct user message from drained notices
  if (notices.length > 0) {
    const parts: string[] = [];
    for (const n of notices) {
      if (n.kind === "event" && n.event) {
        parts.push(`[${n.event.source}:${n.event.type}] ${JSON.stringify(n.event.payload)}`);
      } else if (n.kind === "bus" && n.message) {
        parts.push(`[${n.message.from}] ${n.message.content}`);
      }
    }
    messages.push({
      role: "user",
      content: parts.join("\n"),
    });
  }

  return messages;
}
