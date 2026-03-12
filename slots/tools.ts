import type { SlotFactory, ContextSlot, SlotContext } from "../src/context/types.js";
import { BRAINBOARD_KEYS } from "../src/defaults/brainboard-vars.js";

type ToolMeta = {
  name: string;
  description: string;
  guidance?: string;
  input_schema: { properties: Record<string, any>; required?: string[] };
};

// General cross-tool guidelines, always included when any tools are available.
const GENERAL_GUIDELINES = [
  "Fire independent tool calls in parallel in a single batch.",
  "Code change flow: grep/glob to locate → read_file for context → edit_file/multi_edit to modify.",
  "On tool errors, diagnose from the output before asking the user.",
].join(" ");

const create: SlotFactory = (ctx: SlotContext): ContextSlot => {
  return {
    id: "tools",
    order: 50,
    priority: 8,
    content: () => {
      const toolDefs = (ctx.brainBoard.get(ctx.brainId, BRAINBOARD_KEYS.ACTIVE_TOOLS) ?? []) as ToolMeta[];
      if (toolDefs.length === 0) return "";

      const listLines: string[] = ["## Available Tools"];
      for (const t of toolDefs) {
        const params = Object.entries(t.input_schema.properties)
          .map(([k, v]: [string, any]) => {
            const req = t.input_schema.required?.includes(k) ? ", required" : "";
            return `${k}(${v.type ?? "any"}${req})`;
          })
          .join(", ");
        listLines.push(`- **${t.name}**: ${t.description} [${params}]`);
      }

      const guidanceLines = toolDefs
        .filter((t) => t.guidance)
        .map((t) => t.guidance as string);

      const noteLines = [GENERAL_GUIDELINES, ...guidanceLines];

      return [
        listLines.join("\n"),
        "## Tool Usage Notes\n" + noteLines.join("\n"),
      ].join("\n\n");
    },
    version: 0,
  };
};

export default create;
