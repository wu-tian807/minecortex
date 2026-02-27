/** @desc ConsciousBrain — agentic_os style agent loop: wait → coalesce → drain → process */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrainInterface,
  BrainJson,
  Event,
  ToolDefinition,
  LLMProviderInterface,
  LLMMessage,
  LLMToolCall,
  ToolContext,
} from "./types.js";
import { EventQueue } from "./event-queue.js";
import { assemblePrompt } from "../context/context-engine.js";

const ROOT = process.cwd();

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class ConsciousBrain implements BrainInterface {
  readonly id: string;
  private model: string;
  private provider: LLMProviderInterface;
  private tools: ToolDefinition[];
  private emitFn: (event: Event) => void;
  private brainConfig: BrainJson;
  private eventQueue: EventQueue;
  private coalesceMs: number;
  private sessionHistory: LLMMessage[] = [];

  constructor(opts: {
    id: string;
    model: string;
    provider: LLMProviderInterface;
    tools: ToolDefinition[];
    brainConfig: BrainJson;
    eventQueue: EventQueue;
    coalesceMs: number;
    emit: (event: Event) => void;
  }) {
    this.id = opts.id;
    this.model = opts.model;
    this.provider = opts.provider;
    this.tools = opts.tools;
    this.brainConfig = opts.brainConfig;
    this.eventQueue = opts.eventQueue;
    this.coalesceMs = opts.coalesceMs;
    this.emitFn = opts.emit;
  }

  /** agentic_os style agent loop */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let trigger: Event;
      try {
        trigger = await this.eventQueue.waitForEvent(signal);
      } catch {
        break;
      }

      if ((trigger.priority ?? 1) > 0 && this.coalesceMs > 0) {
        await sleep(this.coalesceMs);
      }

      const events = this.eventQueue.drain();
      if (events.length === 0) continue;

      console.log(`\n[${this.id}] ▶ process [${events.length} events]`);
      try {
        await this.process(events);
      } catch (err) {
        console.error(`[${this.id}] ✗ process failed:`, err);
      }
    }
  }

  private async process(events: Event[]): Promise<void> {
    const messages = await assemblePrompt({
      brainId: this.id,
      model: this.model,
      events,
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
          toolCallId: tc.id,
        };
        this.sessionHistory.push(toolMsg);
        currentMessages.push(toolMsg);
      }
    }

    await this.updateState(events);

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
      emit: this.emitFn,
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

  private async updateState(events: Event[]): Promise<void> {
    const statePath = join(ROOT, "brains", this.id, "state.json");
    let state: Record<string, unknown> = {};
    try {
      state = JSON.parse(await readFile(statePath, "utf-8"));
    } catch { /* fresh state */ }

    state.lastTick = Date.now();
    state.eventsProcessed = events.length;
    state.eventSources = [...new Set(events.map((e) => e.source))];
    state.sessionLength = this.sessionHistory.length;

    await writeFile(statePath, JSON.stringify(state, null, 2));
  }
}
