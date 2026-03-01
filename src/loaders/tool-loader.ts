import { join } from "node:path";
import type { ToolDefinition, FSWatcherAPI } from "../core/types.js";
import type { LoaderContext } from "./types.js";
import { BaseLoader } from "./base-loader.js";

type ToolFactory = { default: ToolDefinition };

export class ToolLoader extends BaseLoader<ToolFactory, ToolDefinition> {
  async importFactory(path: string): Promise<ToolFactory> {
    return await import(path);
  }

  createInstance(factory: ToolFactory, _ctx: LoaderContext, _name: string): ToolDefinition {
    return factory.default;
  }

  onRegister(_name: string, _instance: ToolDefinition): void {}
  onUnregister(_name: string, _instance: ToolDefinition): void {}

  registerWatchPatterns(watcher: FSWatcherAPI): void {
    watcher.register(/tools\/[^/]+\.ts$/, () => {});
    watcher.register(/brains\/[^/]+\/tools\/[^/]+\.ts$/, () => {});
  }

  async load(ctx: LoaderContext): Promise<ToolDefinition[]> {
    const paths = await this.discover(
      join(ctx.globalDir, "tools"),
      join(ctx.brainDir, "tools"),
    );
    await this.loadAll(paths, ctx);
    return [...this.registry.values()].filter(Boolean);
  }
}
