import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { BrainBoardAPI, WatchCallback, FSWatcherAPI } from "./types.js";

const BOARD_FILENAME = "brainboard.json";

export class BrainBoard implements BrainBoardAPI {
  private boards = new Map<string, Map<string, unknown>>();
  private watchers = new Map<string, Map<string, Set<WatchCallback>>>();
  private brainsDir: string;
  private filePath: string;
  private lastWriteTs = 0;

  constructor(brainsDir: string) {
    this.brainsDir = brainsDir;
    this.filePath = join(brainsDir, BOARD_FILENAME);
  }

  loadFromDisk(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(raw) as Record<string, Record<string, unknown>>;
      for (const [brainId, entries] of Object.entries(data)) {
        const board = new Map<string, unknown>();
        for (const [k, v] of Object.entries(entries)) {
          board.set(k, v);
        }
        this.boards.set(brainId, board);
      }
    } catch { /* corrupted or missing — start fresh */ }
  }

  registerFSWatcher(fsWatcher: FSWatcherAPI): void {
    fsWatcher.register(/brainboard\.json$/, () => {
      if (Date.now() - this.lastWriteTs < 500) return;
      this.reloadFromDisk();
    });
  }

  set(brainId: string, key: string, value: unknown): void {
    let board = this.boards.get(brainId);
    if (!board) {
      board = new Map();
      this.boards.set(brainId, board);
    }

    const prev = board.get(key);
    board.set(key, value);
    this.fireWatchers(brainId, key, value, prev);
    this.writeToDisk();
  }

  get(brainId: string, key: string): unknown {
    return this.boards.get(brainId)?.get(key);
  }

  remove(brainId: string, key: string): void {
    const board = this.boards.get(brainId);
    if (!board) return;
    const prev = board.get(key);
    board.delete(key);
    this.fireWatchers(brainId, key, undefined, prev);
    if (board.size === 0) this.boards.delete(brainId);
    this.writeToDisk();
  }

  getAll(brainId: string): Record<string, unknown> {
    const board = this.boards.get(brainId);
    if (!board) return {};
    return Object.fromEntries(board);
  }

  brainIds(): string[] {
    return [...this.boards.keys()];
  }

  removeByPrefix(prefix: string): void {
    for (const brainId of [...this.boards.keys()]) {
      if (brainId.startsWith(prefix)) {
        this.removeAll(brainId);
      }
    }
  }

  removeAll(brainId: string): void {
    const board = this.boards.get(brainId);
    if (!board) return;

    const brainWatchers = this.watchers.get(brainId);
    for (const [key, prev] of board) {
      const keyWatchers = brainWatchers?.get(key);
      if (keyWatchers) {
        for (const cb of keyWatchers) {
          try { cb(undefined, prev); } catch { /* watcher error */ }
        }
      }
    }

    this.boards.delete(brainId);
    this.watchers.delete(brainId);
    this.writeToDisk();
  }

  watch(brainId: string, key: string, cb: WatchCallback): () => void {
    let brainWatchers = this.watchers.get(brainId);
    if (!brainWatchers) {
      brainWatchers = new Map();
      this.watchers.set(brainId, brainWatchers);
    }
    let keyWatchers = brainWatchers.get(key);
    if (!keyWatchers) {
      keyWatchers = new Set();
      brainWatchers.set(key, keyWatchers);
    }
    keyWatchers.add(cb);

    return () => {
      keyWatchers!.delete(cb);
      if (keyWatchers!.size === 0) brainWatchers!.delete(key);
      if (brainWatchers!.size === 0) this.watchers.delete(brainId);
    };
  }

  private fireWatchers(brainId: string, key: string, value: unknown, prev: unknown): void {
    const keyWatchers = this.watchers.get(brainId)?.get(key);
    if (!keyWatchers) return;
    for (const cb of keyWatchers) {
      try { cb(value, prev); } catch { /* watcher error */ }
    }
  }

  private writeToDisk(): void {
    const data: Record<string, Record<string, unknown>> = {};
    for (const [brainId, board] of this.boards) {
      if (board.size > 0) data[brainId] = Object.fromEntries(board);
    }
    try {
      writeFileSync(this.filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
      this.lastWriteTs = Date.now();
    } catch { /* write failed — non-critical */ }
  }

  private reloadFromDisk(): void {
    let data: Record<string, Record<string, unknown>>;
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      data = JSON.parse(raw);
    } catch {
      return;
    }

    const allBrainIds = new Set([...this.boards.keys(), ...Object.keys(data)]);

    for (const brainId of allBrainIds) {
      const diskEntries = data[brainId] ?? {};
      const memBoard = this.boards.get(brainId);
      const memEntries = memBoard ? Object.fromEntries(memBoard) : {};

      const allKeys = new Set([...Object.keys(diskEntries), ...Object.keys(memEntries)]);
      for (const key of allKeys) {
        const diskVal = diskEntries[key];
        const memVal = memEntries[key];
        if (JSON.stringify(diskVal) !== JSON.stringify(memVal)) {
          if (diskVal === undefined) {
            const board = this.boards.get(brainId);
            if (board) {
              board.delete(key);
              if (board.size === 0) this.boards.delete(brainId);
            }
          } else {
            let board = this.boards.get(brainId);
            if (!board) {
              board = new Map();
              this.boards.set(brainId, board);
            }
            board.set(key, diskVal);
          }
          this.fireWatchers(brainId, key, diskVal, memVal);
        }
      }
    }
  }
}
