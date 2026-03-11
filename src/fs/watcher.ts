import { watch, type FSWatcher as NodeFSWatcher } from "node:fs";
import { relative, sep } from "node:path";
import type { FSWatcherAPI, WatchRegistration, FSChangeEvent, FSHandler } from "../core/types.js";

let _instance: FSWatcher | null = null;

/** Get the global FSWatcher singleton (null if not yet created). */
export function getFSWatcher(): FSWatcher | null {
  return _instance;
}

/** Create (or return existing) global FSWatcher singleton. */
export function createOrGetFSWatcher(rootDir: string): FSWatcher {
  if (!_instance) _instance = new FSWatcher(rootDir);
  return _instance;
}

interface Registration {
  id: string;
  ownerId?: string;
  pattern: RegExp;
  handler: FSHandler;
  debounceMs: number;
}

const DEFAULT_DEBOUNCE_MS = 300;
let nextId = 0;

export class FSWatcher implements FSWatcherAPI {
  private watcher: NodeFSWatcher;
  private registrations = new Map<string, Registration>();
  private ownerRegistrations = new Map<string, Set<string>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.watcher = watch(rootDir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      this.dispatch(eventType, filename);
    });
    // overlayfs work/work dirs and other kernel-managed paths can trigger EACCES —
    // swallow those silently to avoid crashing the process
    this.watcher.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EACCES" || err.code === "EPERM") return;
      console.warn("[FSWatcher] watch error:", err.message);
    });
  }

  register(pattern: RegExp, handler: FSHandler, opts?: { debounceMs?: number; ownerId?: string }): WatchRegistration {
    const id = `watch_${++nextId}`;
    const reg: Registration = {
      id,
      ownerId: opts?.ownerId,
      pattern,
      handler,
      debounceMs: opts?.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    };
    this.registrations.set(id, reg);
    if (reg.ownerId) {
      let ids = this.ownerRegistrations.get(reg.ownerId);
      if (!ids) {
        ids = new Set();
        this.ownerRegistrations.set(reg.ownerId, ids);
      }
      ids.add(id);
    }

    return {
      id,
      dispose: () => this.disposeRegistration(id),
    };
  }

  unregisterOwner(ownerId: string): void {
    const ids = this.ownerRegistrations.get(ownerId);
    if (!ids) return;
    for (const id of [...ids]) this.disposeRegistration(id);
  }

  close(): void {
    this.watcher.close();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.registrations.clear();
    this.ownerRegistrations.clear();
    if (_instance === this) _instance = null;
  }

  private dispatch(eventType: string, filename: string): void {
    // 用 startsWith(rootDir + sep) 避免路径前缀子串误判（如 /proj 误匹配 /project/...）
    const relPath = filename.startsWith(this.rootDir + sep)
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

  private disposeRegistration(id: string): void {
    const reg = this.registrations.get(id);
    if (!reg) return;
    this.registrations.delete(id);
    if (reg.ownerId) {
      const ids = this.ownerRegistrations.get(reg.ownerId);
      ids?.delete(id);
      if (ids && ids.size === 0) this.ownerRegistrations.delete(reg.ownerId);
    }
    for (const [key, timer] of this.timers) {
      if (key.startsWith(id + ":")) {
        clearTimeout(timer);
        this.timers.delete(key);
      }
    }
  }
}
