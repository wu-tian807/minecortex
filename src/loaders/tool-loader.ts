import { join, relative } from "node:path";
import type {
  CapabilityDescriptor,
  ToolDefinition,
  FSWatcherAPI,
  FSChangeEvent,
  DynamicToolAPI,
} from "../core/types.js";
import type { LoaderContext } from "./types.js";
import { BaseLoader } from "./base-loader.js";
import { discover } from "./scanner.js";

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
  private onToolsChange: ((tools: ToolDefinition[]) => void) | null = null;

  // ─── DynamicRegistry layer ───

  private dynamicMap = new Map<string, ToolDefinition>();

  readonly dynamic: DynamicToolAPI = {
    register: (key: string, tool: ToolDefinition) => {
      this.dynamicMap.set(key, tool);
      this.notifyChange();
    },
    release: (key: string) => {
      this.dynamicMap.delete(key);
      this.notifyChange();
    },
    get: (key: string) => this.dynamicMap.get(key),
    list: () => [...this.dynamicMap.values()],
  };

  setCallback(onChange: (tools: ToolDefinition[]) => void): void {
    this.onToolsChange = onChange;
  }

  async importFactory(path: string): Promise<ToolFactory> {
    return await import(path);
  }

  validateFactory(factory: ToolFactory): boolean {
    const def = factory.default;
    return Boolean(def && typeof def.name === "string" && typeof def.execute === "function");
  }

  createInstance(
    factory: ToolFactory,
    _ctx: LoaderContext,
    name: string,
    _descriptor: CapabilityDescriptor,
  ): ToolDefinition | null {
    const def = factory.default;
    if (!def) return null;
    return { ...def, name };
  }

  allActive(): ToolDefinition[] {
    const staticTools = [...this.registry.values()].filter((t): t is ToolDefinition => t !== null);
    const dynamicTools = [...this.dynamicMap.values()];
    return [...staticTools, ...dynamicTools];
  }

  private notifyChange(): void {
    this.onToolsChange?.(this.allActive());
  }

  onRegister(_name: string, _instance: ToolDefinition | null): void {
    this.notifyChange();
  }

  onUnregister(_name: string, _instance: ToolDefinition | null): void {
    this.notifyChange();
  }

  registerWatchPatterns(watcher: FSWatcherAPI): void {
    watcher.register(/^tools(?:\/[^/]+)?\/[^/]+\.ts$/, (e) => this.handleChange(e));
    watcher.register(/^brains\/[^/]+\/tools(?:\/[^/]+)?\/[^/]+\.ts$/, (e) => this.handleChange(e));
  }

  private handleChange(event: FSChangeEvent): void {
    if (!this.loaderCtx) return;
    if (!this.matchesConfiguredDir(event.path)) return;

    this.reloadAll()
      .then(() => console.log(`[ToolLoader] refreshed: ${event.path}`))
      .catch(err => console.error(`[ToolLoader] refresh failed: ${event.path}`, err));
  }

  private matchesConfiguredDir(path: string): boolean {
    if (!this.loaderCtx) return false;
    return this.loaderCtx.capabilitySources.some((source) => {
      const dir = source.dir;
      const prefix = relative(this.loaderCtx!.globalDir, dir).replace(/\\/g, "/");
      return prefix.length > 0 && (path === prefix || path.startsWith(`${prefix}/`));
    });
  }

  async load(ctx: LoaderContext): Promise<ToolDefinition[]> {
    this.loaderCtx = ctx;
    const descriptors = await discover(ctx.capabilitySources);
    this.clearRegistry();
    await this.loadAll(descriptors, ctx);
    return this.allActive();
  }

  private async reloadAll(): Promise<void> {
    if (!this.loaderCtx) return;
    const descriptors = await discover(this.loaderCtx.capabilitySources);
    this.clearRegistry();
    await this.loadAll(descriptors, this.loaderCtx);
    this.notifyChange();
  }
}
