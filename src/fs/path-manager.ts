import { resolve, join, normalize } from "node:path";
import type { PathManagerAPI } from "../core/types.js";

export class PathManager implements PathManagerAPI {
  private projectRoot: string;
  private knownDirs: Map<string, string>;

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot);
    this.knownDirs = new Map([
      ["brains", join(this.projectRoot, "brains")],
      ["tools", join(this.projectRoot, "tools")],
      ["slots", join(this.projectRoot, "slots")],
      ["subscriptions", join(this.projectRoot, "subscriptions")],
      ["directives", join(this.projectRoot, "directives")],
      ["skills", join(this.projectRoot, "skills")],
      ["workspace", this.projectRoot],
      ["terminals", join(this.projectRoot, "workspace", "terminals")],
      ["key", join(this.projectRoot, "key")],
    ]);
  }

  root(): string {
    return this.projectRoot;
  }

  dir(name: string): string {
    const d = this.knownDirs.get(name);
    if (!d) throw new Error(`Unknown directory alias: ${name}`);
    return d;
  }

  brainDir(brainId: string): string {
    return join(this.knownDirs.get("brains")!, brainId);
  }

  resolve(input: { path: string; brain?: string }, callerBrainId: string): string {
    const targetBrain = input.brain ?? callerBrainId;
    const raw = input.path;

    if (this.isBrainLocalPattern(raw)) {
      return resolve(this.brainDir(targetBrain), raw);
    }

    if (raw.startsWith("/")) return normalize(raw);

    return resolve(this.projectRoot, raw);
  }

  checkPermission(
    absPath: string,
    op: "read" | "write",
    callerBrainId: string,
    evolve: boolean,
  ): boolean {
    const normalized = normalize(absPath);

    if (op === "read") return true;

    // write op — src/ is always forbidden
    const srcDir = join(this.projectRoot, "src");
    if (normalized.startsWith(srcDir + "/") || normalized === srcDir) return false;

    // Own brain dir is always writable
    const ownBrainDir = this.brainDir(callerBrainId);
    if (normalized.startsWith(ownBrainDir + "/") || normalized === ownBrainDir) return true;

    // Other brain dirs or global dirs: only in evolve mode
    const brainsDir = this.knownDirs.get("brains")!;
    if (normalized.startsWith(brainsDir + "/")) {
      return evolve;
    }

    // Global project files: evolve mode only
    if (normalized.startsWith(this.projectRoot + "/") || normalized === this.projectRoot) {
      return evolve;
    }

    // Outside project root: deny
    return false;
  }

  private isBrainLocalPattern(raw: string): boolean {
    if (raw.startsWith("/")) return false;
    const localPrefixes = [
      "state.json",
      "brain.json",
      "memory/",
      "src/",
      "notes/",
      "inbox/",
      "outbox/",
    ];
    return localPrefixes.some(p => raw === p || raw.startsWith(p));
  }
}
