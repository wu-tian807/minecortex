/** @desc ScriptBrain — runs user-defined TypeScript scripts */

import { pathToFileURL } from "node:url";
import { isAbsolute, join } from "node:path";
import type { ScriptContext, Event, BrainInitConfig } from "./types.js";
import { BaseBrain } from "./base-brain.js";
import { SubscriptionLoader } from "../loaders/subscription-loader.js";
import { SubscriptionRegistry } from "./subscription-registry.js";
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

  constructor(config: BrainInitConfig) {
    super(config);
    this.ctx = {
      brainId: this.id,
      eventBus: this.boundEventBus,
      brainBoard: this.brainBoard,
    };
    this.subscriptionLoader = new SubscriptionLoader();
    this.subscriptionRegistry = new SubscriptionRegistry();

    this.subscriptionLoader.setLogContext(this.id);
    this.subscriptionLoader.setEmitter((event) => this.pushEvent(event));
    this.subscriptionLoader.setBrainContext({
      id: this.id,
      brainDir: this.brainDir,
      hooks: this.hooks,
      brainBoard: this.brainBoard,
      pathManager: this.pathManager,
      eventBus: this.boundEventBus,
      queueCommand: () => {
        this.logger.warn(this.id, 0, "queueCommand is not supported in ScriptBrain");
      },
    });
    this.subscriptionLoader.setCallback((sources) => this.subscriptionRegistry.replaceStatic(sources));
    this.subscriptionRegistry.setEmitter((event) => this.pushEvent(event));
  }

  async initCapabilities(): Promise<void> {
    if (this.fsWatcher) {
      this.subscriptionLoader.registerWatchPatterns(this.fsWatcher, this.id);
    }

    await this.subscriptionLoader.load({
      brainId: this.id,
      brainDir: this.brainDir,
      pathManager: this.pathManager,
      selector: this.brainJson.subscriptions ?? BRAIN_DEFAULTS.subscriptions,
      capabilitySources: BaseLoader.buildSources(
        this.pathManager,
        this.id,
        "subscriptions",
        this.resolveRedirectPath(this.brainJson.paths?.subscriptions),
      ),
    });
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

  private resolveRedirectPath(redirected?: string): string | undefined {
    if (!redirected) return undefined;
    return isAbsolute(redirected) ? redirected : join(this.pathManager.root(), redirected);
  }
}
