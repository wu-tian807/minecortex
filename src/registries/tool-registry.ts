import type { DynamicToolAPI, ToolDefinition } from "../core/types.js";
import type { ToolRegistryChangeHandler } from "./types.js";

export class ToolRegistry implements DynamicToolAPI {
  private staticTools = new Map<string, ToolDefinition>();
  private dynamicTools = new Map<string, ToolDefinition>();
  private onChange: ToolRegistryChangeHandler | null = null;

  setOnChange(cb: ToolRegistryChangeHandler): void {
    this.onChange = cb;
  }

  replaceStatic(tools: ToolDefinition[]): void {
    this.staticTools = new Map(tools.map((tool) => [tool.name, tool]));
    this.notifyChange();
  }

  register(key: string, tool: ToolDefinition): void {
    this.dynamicTools.set(key, tool);
    this.notifyChange();
  }

  release(key: string): void {
    this.dynamicTools.delete(key);
    this.notifyChange();
  }

  get(key: string): ToolDefinition | undefined {
    return this.dynamicTools.get(key);
  }

  list(): ToolDefinition[] {
    return [...this.dynamicTools.values()];
  }

  all(): ToolDefinition[] {
    return [...this.staticTools.values(), ...this.dynamicTools.values()];
  }

  clear(): void {
    this.staticTools.clear();
    this.dynamicTools.clear();
    this.notifyChange();
  }

  private notifyChange(): void {
    this.onChange?.(this.all());
  }
}
