import type {
  CapabilityDescriptor,
  ToolDefinition,
} from "../core/types.js";
import type { LoaderContext } from "./types.js";
import { BaseLoader } from "./base-loader.js";

type ToolLike = Partial<ToolDefinition>;

type ToolFactory = { default?: ToolLike };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidInputSchema(value: unknown): value is ToolDefinition["input_schema"] {
  if (!isPlainObject(value)) return false;
  if (value.type !== "object") return false;
  return isPlainObject(value.properties);
}

function normalizeToolDefinition(
  def: ToolLike | undefined,
  exposedName: string,
): ToolDefinition | null {
  if (!def) return null;
  if (typeof def.name !== "string") {
    console.warn(`[ToolLoader] skipped "${exposedName}": missing string "name"`);
    return null;
  }
  if (typeof def.description !== "string") {
    console.warn(`[ToolLoader] skipped "${exposedName}": missing string "description"`);
    return null;
  }
  if (typeof def.execute !== "function") {
    console.warn(`[ToolLoader] skipped "${exposedName}": missing function "execute"`);
    return null;
  }

  if (!isValidInputSchema(def.input_schema)) {
    console.warn(
      `[ToolLoader] skipped "${exposedName}": missing valid "input_schema" object schema`,
    );
    return null;
  }

  return {
    name: exposedName,
    description: def.description,
    guidance: def.guidance,
    ccVersion: def.ccVersion,
    input_schema: def.input_schema,
    execute: def.execute,
  };
}

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

  setCallback(onChange: (tools: ToolDefinition[]) => void): void {
    this.onToolsChange = onChange;
  }

  // ─── BaseLoader 抽象接口 ───

  async importFactory(path: string): Promise<ToolFactory> {
    return await import(path);
  }

  validateFactory(factory: ToolFactory): boolean {
    return normalizeToolDefinition(factory.default, factory.default?.name ?? "(anonymous)") !== null;
  }

  createInstance(
    factory: ToolFactory,
    _ctx: LoaderContext,
    name: string,
    _descriptor: CapabilityDescriptor,
  ): ToolDefinition | null {
    return normalizeToolDefinition(factory.default, name);
  }

  onRegister(_name: string, _instance: ToolDefinition | null): void {
    this.notifyChange();
  }

  onUnregister(_name: string, _instance: ToolDefinition | null): void {
    this.notifyChange();
  }

  // ─── 公共 API ───

  allStatic(): ToolDefinition[] {
    return [...this.registry.values()].filter((tool): tool is ToolDefinition => tool !== null);
  }

  async load(ctx: LoaderContext): Promise<ToolDefinition[]> {
    await this._loadInternal(ctx);
    return this.allStatic();
  }

  /** 注册 watch 后 reload 时额外通知 tool registry 变更。 */
  protected override async reloadAll(): Promise<void> {
    await super.reloadAll();
    this.notifyChange();
  }

  private notifyChange(): void {
    this.onToolsChange?.(this.allStatic());
  }
}
