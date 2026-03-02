import { join } from "node:path";
import type { ToolDefinition, FSWatcherAPI, FSChangeEvent } from "../core/types.js";
import type { LoaderContext } from "./types.js";
import { BaseLoader } from "./base-loader.js";

type ToolFactory = { default: ToolDefinition };

export class ToolLoader extends BaseLoader<ToolFactory, ToolDefinition> {
  private loaderCtx: LoaderContext | null = null;
  private toolPaths: Map<string, string> = new Map();
  private onToolsChange: ((tools: ToolDefinition[]) => void) | null = null;

  setCallback(onChange: (tools: ToolDefinition[]) => void): void {
    this.onToolsChange = onChange;
  }

  async importFactory(path: string): Promise<ToolFactory> {
    return await import(path);
  }

  createInstance(factory: ToolFactory, _ctx: LoaderContext, _name: string): ToolDefinition {
    return factory.default;
  }

  private notifyChange(): void {
    this.onToolsChange?.([...this.registry.values()].filter(Boolean));
  }

  onRegister(_name: string, _instance: ToolDefinition): void {
    this.notifyChange();
  }

  onUnregister(_name: string, _instance: ToolDefinition): void {
    this.notifyChange();
  }

  registerWatchPatterns(watcher: FSWatcherAPI): void {
    watcher.register(/^tools\/[^/]+\.ts$/, (e) => this.handleChange(e));
    watcher.register(/^brains\/[^/]+\/tools\/[^/]+\.ts$/, (e) => this.handleChange(e));
  }

  private handleChange(event: FSChangeEvent): void {
    if (!this.loaderCtx) return;
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

  async load(ctx: LoaderContext): Promise<ToolDefinition[]> {
    this.loaderCtx = ctx;
    const paths = await this.discover(
      join(ctx.globalDir, "tools"),
      join(ctx.brainDir, "tools"),
    );
    this.toolPaths = paths;
    await this.loadAll(paths, ctx);
    return [...this.registry.values()].filter(Boolean);
  }
}
