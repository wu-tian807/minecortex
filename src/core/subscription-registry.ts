import type { DynamicSubscriptionAPI, Event, EventSource } from "./types.js";

export class SubscriptionRegistry implements DynamicSubscriptionAPI {
  private staticSources = new Map<string, EventSource>();
  private dynamicSources = new Map<string, EventSource>();
  private emitter: ((event: Event) => void) | null = null;

  setEmitter(emitter: (event: Event) => void): void {
    this.emitter = emitter;
  }

  replaceStatic(sources: EventSource[]): void {
    this.staticSources = new Map(sources.map((source) => [source.name, source]));
  }

  register(key: string, source: EventSource): void {
    const previous = this.dynamicSources.get(key);
    if (previous) {
      try {
        previous.stop?.();
      } catch {
        // Ignore stop errors while replacing a dynamic subscription.
      }
    }

    this.dynamicSources.set(key, source);
    if (!this.emitter) return;

    try {
      source.start(this.emitter);
    } catch (err) {
      console.error(`[SubscriptionRegistry] failed to start dynamic source "${key}"`, err);
      this.dynamicSources.delete(key);
      try {
        source.stop?.();
      } catch {
        // Ignore cleanup errors on failed start.
      }

      if (!previous) return;

      try {
        this.dynamicSources.set(key, previous);
        previous.start(this.emitter);
      } catch (restoreErr) {
        console.error(`[SubscriptionRegistry] failed to restore previous dynamic source "${key}"`, restoreErr);
        this.dynamicSources.delete(key);
      }
    }
  }

  release(key: string): void {
    const source = this.dynamicSources.get(key);
    if (!source) return;
    try {
      source.stop?.();
    } finally {
      this.dynamicSources.delete(key);
    }
  }

  get(key: string): EventSource | undefined {
    return this.dynamicSources.get(key);
  }

  list(): EventSource[] {
    return [...this.dynamicSources.values()];
  }

  all(): EventSource[] {
    return [...this.staticSources.values(), ...this.dynamicSources.values()];
  }

  clear(): void {
    for (const source of this.dynamicSources.values()) source.stop?.();
    for (const source of this.staticSources.values()) source.stop?.();
    this.dynamicSources.clear();
    this.staticSources.clear();
  }
}
