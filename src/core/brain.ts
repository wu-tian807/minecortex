/** @desc ConsciousBrain — 有 LLM 的意识脑: drain → prompt → LLM → tool loop */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrainInterface,
  BrainBusInterface,
  BrainJson,
  NoticeQueueInterface,
  Notice,
  ToolDefinition,
  LLMProviderInterface,
  LLMMessage,
  LLMToolCall,
  ToolContext,
} from "./types.js";
import { assemblePrompt } from "../context/context-engine.js";

const ROOT = process.cwd();

export class ConsciousBrain implements BrainInterface {
  readonly id: string;
  private model: string;
  private provider: LLMProviderInterface;
  private tools: ToolDefinition[];
  private brainBus: BrainBusInterface;
  private brainConfig: BrainJson;
  private noticeQueue: NoticeQueueInterface;
  private sessionHistory: LLMMessage[] = [];

  constructor(opts: {
    id: string;
    model: string;
    provider: LLMProviderInterface;
    tools: ToolDefinition[];
    brainBus: BrainBusInterface;
    brainConfig: BrainJson;
    noticeQueue: NoticeQueueInterface;
  }) {
    this.id = opts.id;
    this.model = opts.model;
    this.provider = opts.provider;
    this.tools = opts.tools;
    this.brainBus = opts.brainBus;
    this.brainConfig = opts.brainConfig;
    this.noticeQueue = opts.noticeQueue;
    (this.provider as any)._model = opts.model;
  }

  async tick(): Promise<void> {
    const notices = this.noticeQueue.drain();

    const messages = await assemblePrompt({
      brainId: this.id,
      model: this.model,
      notices,
      tools: this.tools,
      sessionHistory: this.sessionHistory,
      brainConfig: this.brainConfig,
    });

    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === "user") {
      this.sessionHistory.push(lastMsg);
    }

    let currentMessages = messages;

    for (;;) {
      const response = await this.provider.chat(currentMessages, this.tools);

      if (response.content) {
        console.log(`[${this.id}] ${response.content}`);
      }

      if (!response.toolCalls || response.toolCalls.length === 0) {
        this.sessionHistory.push({
          role: "assistant",
          content: response.content,
        });
        break;
      }

      this.sessionHistory.push({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
      });
      currentMessages.push({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
      });

      const results = await Promise.all(
        response.toolCalls.map(async (tc) => {
          const result = await this.executeTool(tc);
          const resultStr = JSON.stringify(result);
          console.log(`[${this.id}] tool:${tc.name}(${JSON.stringify(tc.arguments).slice(0, 100)}) → ${resultStr.slice(0, 200)}`);
          return { tc, resultStr };
        }),
      );

      for (const { tc, resultStr } of results) {
        const toolMsg: LLMMessage = {
          role: "tool",
          content: resultStr,
          toolCallId: tc.name,
        };
        this.sessionHistory.push(toolMsg);
        currentMessages.push(toolMsg);
      }
    }

    await this.updateState(notices);

    if (this.sessionHistory.length > 20) {
      this.sessionHistory = this.sessionHistory.slice(-14);
    }
  }

  private async executeTool(tc: LLMToolCall): Promise<unknown> {
    const tool = this.tools.find((t) => t.name === tc.name);
    if (!tool) {
      return { error: `Unknown tool: ${tc.name}` };
    }
    const ctx: ToolContext = {
      brainId: this.id,
      brainBus: this.brainBus,
      readState: async (targetId) => {
        try {
          const raw = await readFile(
            join(ROOT, "brains", targetId, "state.json"),
            "utf-8",
          );
          return JSON.parse(raw);
        } catch {
          return {};
        }
      },
    };
    try {
      return await tool.execute(tc.arguments, ctx);
    } catch (err: any) {
      return { error: err.message };
    }
  }

  private async updateState(notices: Notice[]): Promise<void> {
    const statePath = join(ROOT, "brains", this.id, "state.json");
    let state: Record<string, unknown> = {};
    try {
      state = JSON.parse(await readFile(statePath, "utf-8"));
    } catch { /* fresh state */ }

    state.lastTick = Date.now();
    state.noticesProcessed = notices.length;
    state.noticeKinds = notices.map((n) => n.kind);
    state.sessionLength = this.sessionHistory.length;

    await writeFile(statePath, JSON.stringify(state, null, 2));
  }
}
