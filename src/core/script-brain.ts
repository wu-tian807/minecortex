/** @desc ScriptBrain — runs user-defined TypeScript scripts */

import { watch as fsWatch } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type { ScriptContext, Event, BrainInitConfig, BrainJson } from "./types.js";
import { BaseBrain } from "./base-brain.js";
import { SubscriptionLoader } from "../loaders/subscription-loader.js";
import { SubscriptionRegistry } from "../registries/subscription-registry.js";
import { BaseLoader } from "../loaders/base-loader.js";
import { BRAIN_DEFAULTS } from "../defaults/brain-defaults.js";

interface ScriptModule {
  start?: (ctx: ScriptContext) => void | Promise<void>;
  update: (events: Event[], ctx: ScriptContext) => void | Promise<void>;
}

export class ScriptBrain extends BaseBrain {
  private ctx: ScriptContext;
  private readonly subscriptionLoader: SubscriptionLoader;
  private readonly subscriptionRegistry: SubscriptionRegistry;
  private capabilitiesInitialized = false;

  constructor(config: BrainInitConfig) {
    super(config);
    this.ctx = {
      brainId: this.id,
      brainDir: this.brainDir,
      signal: this.abortController.signal,
      eventBus: this.boundEventBus,
      brainBoard: this.brainBoard,
      pathManager: this.pathManager,
      env: {},
      getBrainJson: () => this.brainJson,
      hooks: this.hooks,
      queueCommand: () => {},
    };
    this.subscriptionLoader = new SubscriptionLoader();
    this.subscriptionRegistry = new SubscriptionRegistry();

    this.subscriptionLoader.setLogContext(this.id);
    this.subscriptionLoader.setEmitter((event) => this.pushEvent(event));
    this.subscriptionLoader.setBrainContext(this.ctx);
    this.subscriptionLoader.setCallback((sources) => this.subscriptionRegistry.replaceStatic(sources));
    this.subscriptionRegistry.setEmitter((event) => this.pushEvent(event));

    const brainJsonPath = join(this.brainDir, "brain.json");
    const watcher = fsWatch(brainJsonPath, () => {
      readFile(brainJsonPath, "utf-8")
        .then(raw => {
          this.brainJson = JSON.parse(raw) as BrainJson;
          if (!this.capabilitiesInitialized) return;
          return this.reloadConfigDrivenCapabilities();
        })
        .catch((err) => {
          this.logger.warn(this.id, 0, `brain.json reload ignored: ${err?.message ?? err}`);
        });
    });
    this.abortController.signal.addEventListener("abort", () => watcher.close(), { once: true });
  }

  async initCapabilities(): Promise<void> {
    if (this.fsWatcher) {
      this.subscriptionLoader.registerWatchPatterns(this.fsWatcher, this.id);
    }

    await this.reloadConfigDrivenCapabilities();
    this.capabilitiesInitialized = true;
  }

  protected async runMain(_signal: AbortSignal): Promise<void> {
    const modulePath = pathToFileURL(join(this.brainDir, "src", "index.ts")).href;
    const mod = (await import(modulePath)) as ScriptModule;

    // Start sources
    this.startSources();

    if (mod.start) await mod.start(this.ctx);

    while (!this.signal.aborted) {
      await this.queue.waitForEvent(this.signal);

      if (this.coalesceMs > 0) {
        await new Promise((r) => setTimeout(r, this.coalesceMs));
      }

      const events = this.queue.drain();
      if (events.length > 0) {
        await mod.update(events, this.ctx);
      }
    }
  }

  override async shutdown(): Promise<void> {
    await super.shutdown();
    this.subscriptionRegistry.clear();
  }

  private async reloadConfigDrivenCapabilities(): Promise<void> {
    await this.subscriptionLoader.load({
      brainId: this.id,
      brainDir: this.brainDir,
      pathManager: this.pathManager,
      selector: this.brainJson.subscriptions ?? BRAIN_DEFAULTS.subscriptions,
      capabilitySources: BaseLoader.buildSources(
        this.pathManager,
        this.id,
        "subscriptions",
      ),
    });
  }
}
