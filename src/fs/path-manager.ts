import { resolve, join, normalize } from "node:path";
import type {
  GlobalLayerAPI,
  BundleLayerAPI,
  LocalLayerAPI,
  PathManagerAPI,
} from "../core/types.js";

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance: PathManager | null = null;

export function initPathManager(projectRoot: string): PathManager {
  _instance = new PathManager(projectRoot);
  return _instance;
}

export function getPathManager(): PathManager {
  if (!_instance) throw new Error("PathManager not initialized — call initPathManager() first.");
  return _instance;
}

// ─── Layer implementations ───────────────────────────────────────────────────

class GlobalLayer implements GlobalLayerAPI {
  constructor(private readonly r: string) {}

  root() { return this.r; }
  toolsDir() { return join(this.r, "tools"); }
  slotsDir() { return join(this.r, "slots"); }
  subscriptionsDir() { return join(this.r, "subscriptions"); }
  extraDir(name: string) { return join(this.r, name); }
  logsDir(brainId?: string) { return brainId ? join(this.r, "logs", brainId) : join(this.r, "logs"); }
  keyDir() { return join(this.r, "key"); }
}

class BundleLayer implements BundleLayerAPI {
  constructor(private readonly r: string) {}

  root() { return this.r; }
  toolsDir() { return join(this.r, "tools"); }
  slotsDir() { return join(this.r, "slots"); }
  subscriptionsDir() { return join(this.r, "subscriptions"); }
  extraDir(name: string) { return join(this.r, name); }
  brainsDir() { return join(this.r, "brains"); }
  sharedDir(sub?: string) { return sub ? join(this.r, "shared", sub) : join(this.r, "shared"); }
}

class LocalLayer implements LocalLayerAPI {
  constructor(private readonly r: string) {}

  root() { return this.r; }
  toolsDir() { return join(this.r, "tools"); }
  slotsDir() { return join(this.r, "slots"); }
  subscriptionsDir() { return join(this.r, "subscriptions"); }
  extraDir(name: string) { return join(this.r, name); }
}

// ─── PathManager ─────────────────────────────────────────────────────────────

export class PathManager implements PathManagerAPI {
  private readonly _root: string;
  private readonly _global: GlobalLayer;
  private readonly _bundle: BundleLayer;

  constructor(projectRoot: string) {
    this._root = resolve(projectRoot);
    this._global = new GlobalLayer(this._root);
    this._bundle = new BundleLayer(join(this._root, "bundle"));
  }

  root() { return this._root; }
  global(): GlobalLayerAPI { return this._global; }
  bundle(): BundleLayerAPI { return this._bundle; }

  local(brainId: string): LocalLayerAPI {
    return new LocalLayer(join(this._bundle.brainsDir(), brainId));
  }

  packDir(packId: string) { return join(this._root, "packs", packId); }
  backupDir(backupId: string) { return join(this._root, "backups", backupId); }

  resolve(input: { path: string; brain?: string }, callerBrainId: string): string {
    const raw = input.path;
    if (raw.startsWith("/")) return normalize(raw);
    return resolve(this.local(input.brain ?? callerBrainId).root(), "workspace", raw);
  }

  checkPermission(absPath: string, op: "read" | "write", _: string, evolve: boolean): boolean {
    if (op === "read") return true;
    const p = normalize(absPath);
    const src = join(this._root, "src");
    if (p.startsWith(src + "/") || p === src) return false;
    const bundleRoot = this._bundle.root();
    if (p.startsWith(bundleRoot + "/") || p === bundleRoot) return true;
    if (evolve && (p.startsWith(this._root + "/") || p === this._root)) return true;
    return false;
  }
}
