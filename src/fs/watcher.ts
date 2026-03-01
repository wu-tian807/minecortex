import { watch, type FSWatcher as NodeFSWatcher } from "node:fs";
import { relative } from "node:path";
import type { FSWatcherAPI, WatchRegistration, FSChangeEvent, FSHandler } from "../core/types.js";

interface Registration {
  id: string;
  pattern: RegExp;
  handler: FSHandler;
  debounceMs: number;
}

const DEFAULT_DEBOUNCE_MS = 300;
let nextId = 0;

export class FSWatcher implements FSWatcherAPI {
  private watcher: NodeFSWatcher;
  private registrations = new Map<string, Registration>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.watcher = watch(rootDir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      this.dispatch(eventType, filename);
    });
  }

  register(pattern: RegExp, handler: FSHandler, opts?: { debounceMs?: number }): WatchRegistration {
    const id = `watch_${++nextId}`;
    const reg: Registration = {
      id,
      pattern,
      handler,
      debounceMs: opts?.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    };
    this.registrations.set(id, reg);

    return {
      id,
      dispose: () => {
        this.registrations.delete(id);
        for (const [key, timer] of this.timers) {
          if (key.startsWith(id + ":")) {
            clearTimeout(timer);
            this.timers.delete(key);
          }
        }
      },
    };
  }

  close(): void {
    this.watcher.close();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.registrations.clear();
  }

  private dispatch(eventType: string, filename: string): void {
    const relPath = filename.includes(this.rootDir)
      ? relative(this.rootDir, filename)
      : filename;

    for (const reg of this.registrations.values()) {
      if (!reg.pattern.test(relPath)) continue;

      const debounceKey = `${reg.id}:${relPath}`;
      const existing = this.timers.get(debounceKey);
      if (existing) clearTimeout(existing);

      const fsEvent: FSChangeEvent = {
        type: eventType === "rename" ? "create" : "modify",
        path: relPath,
        isDir: false,
      };

      const timer = setTimeout(() => {
        this.timers.delete(debounceKey);
        try { reg.handler(fsEvent); } catch { /* consumer error */ }
      }, reg.debounceMs);

      this.timers.set(debounceKey, timer);
    }
  }
}
