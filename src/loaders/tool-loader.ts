import { join, relative } from "node:path";
import type { ToolDefinition, FSWatcherAPI, FSChangeEvent } from "../core/types.js";
import type { LoaderContext } from "./types.js";
import { BaseLoader } from "./base-loader.js";

type ToolFactory = { default?: ToolDefinition };

/**
 * Loads tool definitions from tools/ directories.
 *
 * Files that don't export a valid ToolDefinition (with name + execute) are
 * silently skipped. This allows placing shared utilities in the same folder.
 *
 * Naming convention: prefix helper files with underscore (e.g. `_utils.ts`)
 * to clearly indicate they are not tools.
 */
export class ToolLoader extends BaseLoader<ToolFactory, ToolDefinition | null> {
  private loaderCtx: LoaderContext | null = null;
  private toolPaths: Map<string, string> = new Map();
  private onToolsChange: ((tools: ToolDefinition[]) => void) | null = null;

  setCallback(onChange: (tools: ToolDefinition[]) => void): void {
    this.onToolsChange = onChange;
  }

  async importFactory(path: string): Promise<ToolFactory> {
    return await import(path);
  }

  createInstance(factory: ToolFactory, _ctx: LoaderContext, _name: string): ToolDefinition | null {
    const def = factory.default;
    if (!def || typeof def.name !== "string" || typeof def.execute !== "function") {
      return null;
    }
    return def;
  }

  private notifyChange(): void {
    this.onToolsChange?.(
      [...this.registry.values()].filter((t): t is ToolDefinition => t !== null),
    );
  }

  onRegister(_name: string, _instance: ToolDefinition | null): void {
    this.notifyChange();
  }

  onUnregister(_name: string, _instance: ToolDefinition | null): void {
    this.notifyChange();
  }

  registerWatchPatterns(watcher: FSWatcherAPI): void {
    watcher.register(/^tools\/[^/]+\.ts$/, (e) => this.handleChange(e));
    watcher.register(/^brains\/[^/]+\/tools\/[^/]+\.ts$/, (e) => this.handleChange(e));
  }

  private handleChange(event: FSChangeEvent): void {
    if (!this.loaderCtx) return;
    if (!this.matchesConfiguredDir(event.path)) return;
    const name = event.path.replace(/.*\//, "").replace(/\.ts$/, "");

    if (event.type === "delete") {
      if (this.registry.has(name)) {
        this.registry.delete(name);
        this.toolPaths.delete(name);
        this.notifyChange();
        console.log(`[ToolLoader] removed: ${name}`);
      }
    } else {
      const absolutePath = join(this.loaderCtx.globalDir, event.path);
      this.toolPaths.set(name, absolutePath);
      this.reload(name, absolutePath, this.loaderCtx)
        .then(inst => { if (inst) console.log(`[ToolLoader] hot-reloaded: ${name}`); })
        .catch(err => console.error(`[ToolLoader] reload failed: ${name}`, err));
    }
  }

  private matchesConfiguredDir(path: string): boolean {
    if (!this.loaderCtx) return false;
    const dirs = [
      this.loaderCtx.globalCapabilityDir ?? join(this.loaderCtx.globalDir, "tools"),
      this.loaderCtx.localCapabilityDir ?? join(this.loaderCtx.brainDir, "tools"),
    ];
    return dirs.some((dir) => {
      const prefix = relative(this.loaderCtx!.globalDir, dir).replace(/\\/g, "/");
      return prefix.length > 0 && (path === prefix || path.startsWith(`${prefix}/`));
    });
  }

  async load(ctx: LoaderContext): Promise<ToolDefinition[]> {
    this.loaderCtx = ctx;
    const paths = await this.discover(
      ctx.globalCapabilityDir ?? join(ctx.globalDir, "tools"),
      ctx.localCapabilityDir ?? join(ctx.brainDir, "tools"),
    );
    this.toolPaths = paths;
    await this.loadAll(paths, ctx);
    return [...this.registry.values()].filter((t): t is ToolDefinition => t !== null);
  }
}
