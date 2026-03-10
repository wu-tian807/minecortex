import type {
  CapabilityDescriptor,
  ToolDefinition,
  FSWatcherAPI,
  DynamicToolAPI,
} from "../core/types.js";
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

  // ─── BaseLoader 抽象接口 ───

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

  onRegister(_name: string, _instance: ToolDefinition | null): void {
    this.notifyChange();
  }

  onUnregister(_name: string, _instance: ToolDefinition | null): void {
    this.notifyChange();
  }

  // ─── 公共 API ───

  allActive(): ToolDefinition[] {
    const staticTools = [...this.registry.values()].filter((t): t is ToolDefinition => t !== null);
    const dynamicTools = [...this.dynamicMap.values()];
    return [...staticTools, ...dynamicTools];
  }

  async load(ctx: LoaderContext): Promise<ToolDefinition[]> {
    await this._loadInternal(ctx);
    return this.allActive();
  }

  /** 注册 watch 后 reload 时额外通知 tool registry 变更。 */
  protected override async reloadAll(): Promise<void> {
    await super.reloadAll();
    this.notifyChange();
  }

  private notifyChange(): void {
    this.onToolsChange?.(this.allActive());
  }
}
