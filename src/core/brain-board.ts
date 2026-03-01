import type { BrainBoardAPI, WatchCallback } from "./types.js";

export class BrainBoard implements BrainBoardAPI {
  private boards = new Map<string, Map<string, unknown>>();
  private watchers = new Map<string, Map<string, Set<WatchCallback>>>();

  set(brainId: string, key: string, value: unknown): void {
    let board = this.boards.get(brainId);
    if (!board) {
      board = new Map();
      this.boards.set(brainId, board);
    }

    const prev = board.get(key);
    board.set(key, value);

    const brainWatchers = this.watchers.get(brainId);
    const keyWatchers = brainWatchers?.get(key);
    if (keyWatchers) {
      for (const cb of keyWatchers) {
        try { cb(value, prev); } catch { /* watcher error */ }
      }
    }
  }

  get(brainId: string, key: string): unknown {
    return this.boards.get(brainId)?.get(key);
  }

  remove(brainId: string, key: string): void {
    const board = this.boards.get(brainId);
    if (!board) return;
    const prev = board.get(key);
    board.delete(key);

    const brainWatchers = this.watchers.get(brainId);
    const keyWatchers = brainWatchers?.get(key);
    if (keyWatchers) {
      for (const cb of keyWatchers) {
        try { cb(undefined, prev); } catch { /* watcher error */ }
      }
    }

    if (board.size === 0) this.boards.delete(brainId);
  }

  getAll(brainId: string): Record<string, unknown> {
    const board = this.boards.get(brainId);
    if (!board) return {};
    return Object.fromEntries(board);
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
}
