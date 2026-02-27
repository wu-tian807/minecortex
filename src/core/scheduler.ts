/** @desc Scheduler — discover brains, wire EventSources, start agent loops */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrainInterface,
  BrainJson,
  MineclawConfig,
  Event,
  EventSource,
} from "./types.js";
import { BrainBus } from "./brain-bus.js";
import { EventQueue } from "./event-queue.js";
import { ConsciousBrain } from "./brain.js";
import { loadSubscriptions } from "../loaders/subscription-loader.js";
import { loadTools } from "../loaders/tool-loader.js";
import { createProvider } from "../llm/index.js";

const ROOT = process.cwd();

interface BrainSlot {
  brain: BrainInterface;
  queue: EventQueue;
  abortController: AbortController;
}

export class Scheduler {
  private brainBus = new BrainBus();
  private slots = new Map<string, BrainSlot>();
  private activeSources: EventSource[] = [];

  async start(): Promise<void> {
    console.log("[scheduler] 启动中...");

    const globalConfig = await this.loadGlobalConfig();
    const brainIds = await this.discoverBrains();

    if (brainIds.length === 0) {
      console.warn("[scheduler] brains/ 下没有发现任何脑区");
      return;
    }

    this.brainBus.onRoute((targetId, event) => {
      this.slots.get(targetId)?.queue.push(event);
    });

    for (const brainId of brainIds) {
      await this.initBrain(brainId, globalConfig);
    }

    for (const [id, slot] of this.slots) {
      slot.brain.run(slot.abortController.signal)
        .catch(err => console.error(`[scheduler] brain '${id}' loop crashed:`, err));
    }

    console.log("[scheduler] 就绪，所有 brain loop 已启动\n");
  }

  private async discoverBrains(): Promise<string[]> {
    const brainsDir = join(ROOT, "brains");
    try {
      const entries = await readdir(brainsDir);
      const ids: string[] = [];
      for (const entry of entries) {
        const s = await stat(join(brainsDir, entry));
        if (s.isDirectory()) {
          ids.push(entry);
        }
      }
      return ids;
    } catch {
      return [];
    }
  }

  private async initBrain(brainId: string, globalConfig: MineclawConfig): Promise<void> {
    this.brainBus.register(brainId);

    const brainConfig = await this.loadBrainConfig(brainId);
    const queue = new EventQueue();
    const abortController = new AbortController();

    const sources = await loadSubscriptions(brainId, brainConfig);
    for (const source of sources) {
      source.start((event: Event) => queue.push(event));
      this.activeSources.push(source);
    }

    const tools = await loadTools(brainId, brainConfig);
    const model = brainConfig.model ?? globalConfig.defaults?.model;

    if (!model) {
      console.log(`[scheduler] 脑区 '${brainId}' 无 model，跳过 (脚本脑待实现)`);
      return;
    }

    const brainBus = this.brainBus;
    const provider = createProvider(model, brainConfig);
    const brain = new ConsciousBrain({
      id: brainId,
      model,
      provider,
      tools,
      brainConfig,
      eventQueue: queue,
      coalesceMs: brainConfig.coalesceMs ?? 300,
      emit(event: Event) {
        const to = (event.payload as any)?.to as string | undefined;
        if (to && to !== brainId) {
          brainBus.route(event);
        } else {
          queue.push(event);
        }
      },
    });

    this.slots.set(brainId, { brain, queue, abortController });

    console.log(
      `[scheduler] 脑区 '${brainId}' 就绪 (model: ${model}, tools: [${tools.map((t) => t.name).join(",")}])`,
    );
  }

  async stop(): Promise<void> {
    for (const [, slot] of this.slots) {
      slot.abortController.abort();
    }
    for (const source of this.activeSources) {
      source.stop();
    }
    console.log("[scheduler] 已停止");
  }

  private async loadGlobalConfig(): Promise<MineclawConfig> {
    try {
      const raw = await readFile(join(ROOT, "mineclaw.json"), "utf-8");
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private async loadBrainConfig(brainId: string): Promise<BrainJson> {
    try {
      const raw = await readFile(
        join(ROOT, "brains", brainId, "brain.json"),
        "utf-8",
      );
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
}
