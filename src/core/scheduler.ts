/** @desc Scheduler — 扫描 brains/ 目录自动发现脑，WakePolicy 驱动调度 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrainInterface,
  BrainJson,
  MineclawConfig,
  Notice,
  Event,
  EventSource,
  WakePolicy,
  ToolDefinition,
} from "./types.js";
import { BrainBus } from "./brain-bus.js";
import { NoticeQueue } from "./notice-queue.js";
import { ConsciousBrain } from "./brain.js";
import { loadSubscriptions } from "../loaders/subscription-loader.js";
import { loadTools } from "../loaders/tool-loader.js";
import { loadWakePolicy } from "../loaders/wake-loader.js";
import { createProvider } from "../llm/index.js";

const ROOT = process.cwd();

interface BrainSlot {
  brain: BrainInterface;
  queue: NoticeQueue;
  policy: WakePolicy;
  busy: boolean;
  wakeRequested: boolean;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  coalesceTimer?: ReturnType<typeof setTimeout>;
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

    for (const brainId of brainIds) {
      await this.initBrain(brainId, globalConfig);
    }

    this.brainBus.onMessage((msg) => {
      const targets =
        msg.to === "*"
          ? [...this.slots.keys()].filter((id) => id !== msg.from)
          : [msg.to];

      for (const targetId of targets) {
        this.pushNotice(targetId, {
          kind: "bus",
          message: msg,
          ts: Date.now(),
        });
      }
    });

    console.log("[scheduler] 就绪，等待事件触发...\n");
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
    const policy = await loadWakePolicy(brainId);
    const queue = new NoticeQueue();

    const sources = await loadSubscriptions(brainId, brainConfig);
    for (const source of sources) {
      source.start((event: Event) => {
        this.pushNotice(brainId, {
          kind: "event",
          event,
          ts: Date.now(),
        });
      });
      this.activeSources.push(source);
    }

    const tools = await loadTools(brainId, brainConfig);
    const model = brainConfig.model ?? globalConfig.defaults?.model;

    if (!model) {
      console.log(`[scheduler] 脑区 '${brainId}' 无 model，跳过 (脚本脑待实现)`);
      return;
    }

    const provider = createProvider(model, brainConfig);
    const brain = new ConsciousBrain({
      id: brainId,
      model,
      provider,
      tools,
      brainBus: this.brainBus,
      brainConfig,
      noticeQueue: queue,
    });

    const slot: BrainSlot = {
      brain,
      queue,
      policy,
      busy: false,
      wakeRequested: false,
    };
    this.slots.set(brainId, slot);

    if (policy.heartbeatMs && policy.heartbeatMs > 0) {
      slot.heartbeatTimer = setInterval(() => {
        this.wake(brainId);
      }, policy.heartbeatMs);
    }

    console.log(
      `[scheduler] 脑区 '${brainId}' 就绪 (model: ${model}, tools: [${tools.map((t) => t.name).join(",")}])`,
    );
  }

  private pushNotice(brainId: string, notice: Notice): void {
    const slot = this.slots.get(brainId);
    if (!slot) return;

    slot.queue.push(notice);

    const shouldWake = slot.policy.shouldWake(notice, {
      pending: slot.queue.pending(),
    });
    if (!shouldWake) return;

    const coalesceMs = slot.policy.coalesceMs;
    if (coalesceMs && coalesceMs > 0) {
      if (slot.coalesceTimer) return;
      slot.coalesceTimer = setTimeout(() => {
        slot.coalesceTimer = undefined;
        this.wake(brainId);
      }, coalesceMs);
    } else {
      this.wake(brainId);
    }
  }

  private wake(brainId: string): void {
    const slot = this.slots.get(brainId);
    if (!slot) return;

    if (slot.busy) {
      slot.wakeRequested = true;
      return;
    }

    this.runTick(brainId, slot);
  }

  private async runTick(brainId: string, slot: BrainSlot): Promise<void> {
    slot.busy = true;
    slot.wakeRequested = false;

    const noticeCount = slot.queue.pending();
    console.log(`\n[scheduler] ▶ ${brainId}.tick() [${noticeCount} notices]`);

    try {
      await slot.brain.tick();
    } catch (err) {
      console.error(`[scheduler] ✗ ${brainId}.tick() 失败:`, err);
    }

    slot.busy = false;

    if (slot.wakeRequested || slot.queue.pending() > 0) {
      slot.wakeRequested = false;
      this.runTick(brainId, slot);
    }
  }

  async stop(): Promise<void> {
    for (const [, slot] of this.slots) {
      if (slot.heartbeatTimer) clearInterval(slot.heartbeatTimer);
      if (slot.coalesceTimer) clearTimeout(slot.coalesceTimer);
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
