import { resolve, join, normalize, isAbsolute, sep } from "node:path";
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
  logsDir(brainId?: string) { return brainId ? join(this.r, "logs", brainId) : join(this.r, "logs"); }
  keyDir() { return join(this.r, "key"); }
  packsDir() { return join(this.r, "packs"); }
  backupsDir() { return join(this.r, "backups"); }
  minecortexConfig() { return join(this.r, "minecortex.json"); }
}

class BundleLayer implements BundleLayerAPI {
  constructor(private readonly r: string) {}

  root() { return this.r; }
  toolsDir() { return join(this.r, "tools"); }
  slotsDir() { return join(this.r, "slots"); }
  subscriptionsDir() { return join(this.r, "subscriptions"); }
  brainsDir() { return join(this.r, "brains"); }
  
  manifest() { return join(this.r, "manifest.json"); }
  stateDir() { return join(this.r, "state"); }
  
  sharedDir() { return join(this.r, "shared"); }
  sharedWorkspace() { return join(this.r, "shared", "workspace"); }
  
  sandboxDir() { return join(this.r, "shared", "sandbox"); }
  sandboxMounts() { return join(this.r, "shared", "sandbox", "mounts.json"); }
  sandboxOverlays() { return join(this.r, "shared", "sandbox", "overlays"); }
}

class LocalLayer implements LocalLayerAPI {
  constructor(private readonly r: string) {}

  root() { return this.r; }
  sessionsDir() { return join(this.r, "sessions"); }
  toolsDir() { return join(this.r, "tools"); }
  slotsDir() { return join(this.r, "slots"); }
  subscriptionsDir() { return join(this.r, "subscriptions"); }
  
  config() { return join(this.r, "brain.json"); }
  soul() { return join(this.r, "soul.md"); }
  homeDir() { return join(this.r, ".home"); }
  tmpDir() { return join(this.r, ".tmp"); }
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
    if (isAbsolute(raw)) return normalize(raw);
    return resolve(this.local(input.brain ?? callerBrainId).homeDir(), raw);
  }

  checkPermission(absPath: string, op: "read" | "write", _: string, evolve: boolean): boolean {
    if (op === "read") return true;
    const p = normalize(absPath);
    const src = join(this._root, "src");
    if (p.startsWith(src + sep) || p === src) return false;
    const bundleRoot = this._bundle.root();
    if (p.startsWith(bundleRoot + sep) || p === bundleRoot) return true;
    if (evolve && (p.startsWith(this._root + sep) || p === this._root)) return true;
    return false;
  }
}
