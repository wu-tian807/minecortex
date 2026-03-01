import { join, basename } from "node:path";
import type { ToolDefinition, FSWatcherAPI } from "../core/types.js";
import type { LoaderContext } from "./types.js";
import { BaseLoader } from "./base-loader.js";

type ToolFactory = { default: ToolDefinition };

export class ToolLoader extends BaseLoader<ToolFactory, ToolDefinition> {
  private lastCtx: LoaderContext | null = null;
  private pathMap = new Map<string, string>();

  async importFactory(path: string): Promise<ToolFactory> {
    return await import(path);
  }

  createInstance(factory: ToolFactory, _ctx: LoaderContext, _name: string): ToolDefinition {
    return factory.default;
  }

  onRegister(_name: string, _instance: ToolDefinition): void {}
  onUnregister(_name: string, _instance: ToolDefinition): void {}

  registerWatchPatterns(watcher: FSWatcherAPI): void {
    const self = this;
    const handler = (event: import("../core/types.js").FSChangeEvent) => {
      if (!self.lastCtx) return;
      const name = basename(event.path, ".ts");
      const fullPath = self.pathMap.get(name);
      if (fullPath) {
        self.reload(name, fullPath, self.lastCtx)
          .then(inst => { if (inst) console.log(`[ToolLoader] hot-reloaded: ${name}`); })
          .catch(err => console.error(`[ToolLoader] hot-reload failed: ${name}`, err));
      }
    };
    watcher.register(/tools\/[^/]+\.ts$/, handler);
    watcher.register(/brains\/[^/]+\/tools\/[^/]+\.ts$/, handler);
  }

  async load(ctx: LoaderContext): Promise<ToolDefinition[]> {
    this.lastCtx = ctx;
    const paths = await this.discover(
      join(ctx.globalDir, "tools"),
      join(ctx.brainDir, "tools"),
    );
    this.pathMap = paths;
    await this.loadAll(paths, ctx);
    return [...this.registry.values()].filter(Boolean);
  }
}
