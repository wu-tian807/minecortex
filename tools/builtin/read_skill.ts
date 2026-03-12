import type { ToolDefinition } from "../../src/core/types.js";
import { loadSkillByName } from "../../slots/lib/skills-loader.js";

export default {
  name: "read_skill",
  description:
    "Read the full content of a skill by name, including supporting file indexes. Use this after seeing the skills summary to get detailed instructions.",
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
    const skill = loadSkillByName(ctx.pathManager, ctx.brainId, name);
    if (!skill) return `Skill "${name}" not found.`;

    const sections = [
      `# Skill: ${skill.name}`,
      "",
      `- Description: ${skill.description}`,
      `- File: ${skill.filePath}`,
    ];

    sections.push("", "## Instructions", "", skill.content);
    if (skill.references.length > 0) {
      sections.push("", "## References", ...skill.references.map((entry) => `- ${entry}`));
    }
    if (skill.scripts.length > 0) {
      sections.push("", "## Scripts", ...skill.scripts.map((entry) => `- ${entry}`));
    }
    if (skill.assets.length > 0) {
      sections.push("", "## Assets", ...skill.assets.map((entry) => `- ${entry}`));
    }

    if (
      skill.references.length > 0 ||
      skill.scripts.length > 0 ||
      skill.assets.length > 0
    ) {
      sections.push(
        "",
        "Use the standard read_file tool to inspect any listed supporting file, and use shell/exec tools directly when the skill asks you to run a script.",
      );
    }

    return sections.join("\n");
  },
} satisfies ToolDefinition;
