import type { SlotFactory, ContextSlot, SlotContext } from "../src/context/types.js";

const create: SlotFactory = (ctx: SlotContext): ContextSlot => {
  const toolDefs = (ctx.config?.toolDefinitions ?? []) as Array<{
    name: string;
    description: string;
    input_schema: { properties: Record<string, any>; required?: string[] };
  }>;

  return {
    id: "tools",
    kind: "system",
    order: 50,
    priority: 8,
    content: () => {
      if (toolDefs.length === 0) return "";

      const lines: string[] = ["## Available Tools"];
      for (const t of toolDefs) {
        const params = Object.entries(t.input_schema.properties)
          .map(([k, v]: [string, any]) => {
            const req = t.input_schema.required?.includes(k) ? ", required" : "";
            return `${k}(${v.type ?? "any"}${req})`;
          })
          .join(", ");
        lines.push(`- **${t.name}**: ${t.description} [${params}]`);
      }
      return lines.join("\n");
    },
    version: 0,
  };
};

export default create;
