/** @desc BaseBrain — abstract base class for all brain implementations */

import type {
  BrainInterface,
  BrainInitConfig,
  BrainJson,
  Event,
  EventSource,
  EventBusAPI,
  BrainBoardAPI,
  PathManagerAPI,
  TerminalManagerAPI,
} from "./types.js";
import type { Logger } from "./logger.js";
import type { EventBus } from "./event-bus.js";
import { EventQueue } from "./event-queue.js";
import { BrainHooks } from "../hooks/brain-hooks.js";
import { BRAIN_DEFAULTS } from "../defaults/brain-defaults.js";

export abstract class BaseBrain implements BrainInterface {
  readonly id: string;

  // Brain-specific config
  protected brainJson: BrainJson;
  protected readonly brainDir: string;

  // Self-owned components (unique per instance)
  readonly queue: EventQueue;
  protected readonly abortController = new AbortController();
  readonly hooks: BrainHooks;
  protected sources: EventSource[] = [];

  // Shared singletons (passed in via config)
  protected readonly brainBoard: BrainBoardAPI;
  protected readonly pathManager: PathManagerAPI;
  protected readonly terminalManager: TerminalManagerAPI;
  protected readonly logger: Logger;
  protected readonly eventBus: EventBus;

  /** Brain-bound EventBus facade exposed to tools, subscriptions and scheduler. */
  readonly boundEventBus: EventBusAPI;

  constructor(config: BrainInitConfig) {
    this.id = config.id;
    this.brainDir = config.brainDir;
    this.brainJson = config.brainJson;

    // Shared singletons
    this.brainBoard = config.brainBoard;
    this.pathManager = config.pathManager;
    this.terminalManager = config.terminalManager;
    this.logger = config.logger;
    this.eventBus = config.eventBus;

    // Self-owned components
    this.queue = new EventQueue();
    this.hooks = new BrainHooks();

    // Register this brain's queue with the event bus
    this.eventBus.register(this.id, this.queue);

    // Bound facade: emit() goes through globalHandlers+routing; emitToSelf() goes to own queue only.
    const brainId = this.id;
    const bus = this.eventBus;
    const queue = this.queue;
    this.boundEventBus = {
      emit: (event: Event) => bus.emit(event, brainId),
      emitToSelf: (event: Event) => queue.push(event),
      observe: (handler: (event: Event) => void) => bus.observe(handler),
    };
  }

  /** Subclasses implement the main loop */
  abstract run(signal: AbortSignal): Promise<void>;

  /** Set event sources (called by Scheduler after loading subscriptions) */
  setSources(sources: EventSource[]): void {
    this.sources = sources;
  }

  /** Start all event sources (only for sources not yet started by loader) */
  protected startSources(): void {
    // Note: SubscriptionLoader already calls start() in onRegister,
    // so this is only needed for sources added via setSources() without going through loader
    // Currently this is a no-op because all sources come from the loader
  }

  /** Stop the brain loop (abort signal) */
  stop(): void {
    this.abortController.abort();
  }

  /** Full shutdown: stop loop, close sources, unregister from eventBus */
  async shutdown(): Promise<void> {
    this.abortController.abort();
    for (const src of this.sources) {
      try {
        src.stop();
      } catch { /* ignore */ }
    }
    this.eventBus.unregister(this.id);
  }

  /** Complete cleanup: shutdown + clear brainBoard data + hooks */
  async free(): Promise<void> {
    // Emit event before shutdown (while still registered with eventBus)
    this.eventBus.emit({
      source: `brain:${this.id}`,
      type: "brain_freed",
      payload: { brainId: this.id },
      ts: Date.now(),
      silent: true,
    }, this.id);

    await this.shutdown();
    this.brainBoard.removeByPrefix(`${this.id}:`);
    this.brainBoard.removeAll(this.id);
    this.hooks.clear();
    this.logger.info(this.id, 0, "free() complete — brainBoard cleared");
  }

  /** Push an event to this brain's queue */
  pushEvent(event: Event): void {
    this.queue.push(event);
  }

  /** Get the abort signal for this brain */
  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /** Get coalesce delay from config */
  protected get coalesceMs(): number {
    return this.brainJson.coalesceMs ?? BRAIN_DEFAULTS.coalesceMs;
  }
}
