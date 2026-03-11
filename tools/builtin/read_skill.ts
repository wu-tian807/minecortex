import type { ToolDefinition } from "../../src/core/types.js";
import { readSkillByName } from "../../slots/lib/skills-loader.js";

export default {
  name: "read_skill",
  description:
    "Read the full content of a skill by name. Use this after seeing the skills summary to get detailed instructions.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The skill name as shown in the Available Skills list",
      },
    },
    required: ["name"],
  },
  async execute(args, ctx) {
    const name = String(args.name);
    const content = readSkillByName(ctx.pathManager, ctx.brainId, name);
    if (!content) return `Skill "${name}" not found.`;
    return content;
  },
} satisfies ToolDefinition;
